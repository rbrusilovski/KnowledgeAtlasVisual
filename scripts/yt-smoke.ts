/**
 * pnpm yt:smoke [@handle|UC…] — READ-ONLY live API verification. Exercises resolution, channels.list (all parts),
 * uploads-playlist pagination, batched videos.list, normalization + coverage, error mapping and quota accounting
 * through the same metered client the app uses. Writes NOTHING to the database (responses are not cached either).
 * Prints a sanitized summary only (never the API key).
 *
 * Live mode still requires YOUTUBE_LIVE_COLLECTION_ENABLED=true for the process (set it inline for a one-off run).
 */
import "dotenv/config";

const { env } = await import("@/server/env");
const { redis } = await import("@/server/redis");
const { db } = await import("@/server/db");
const { youtube, withYouTubeContext, rawClient, normalizeChannel, normalizeVideo, YouTubeApiError } = await import("@/server/youtube");
const { LiveYouTubeClient } = await import("@/server/youtube/live");
const { resolveChannelInput } = await import("@/server/youtube/resolve");
const { usage } = await import("@/server/services/quota");

const input = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "@3blue1brown";
const tally: Record<string, { calls: number; units: number; bucket: string }> = {};
const ctx = { lane: "interactive" as const, noCache: true, onCost: (m: string, bucket: string, units: number) => ((tally[m] ??= { calls: 0, units: 0, bucket }), tally[m].calls++, (tally[m].units += units)) };
const out: Record<string, unknown> = {};
const ok = (name: string, pass: boolean, detail?: unknown) => {
  out.checks ??= [] as unknown[];
  (out.checks as unknown[]).push({ name, pass, ...(detail !== undefined ? { detail } : {}) });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ""}`);
};
const count = <T,>(xs: T[], f: (x: T) => string) => xs.reduce<Record<string, number>>((a, x) => ((a[f(x)] = (a[f(x)] ?? 0) + 1), a), {});

try {
  const before = await usage();
  ok("YOUTUBE_MODE=live selects the live client", env.YOUTUBE_MODE === "live" && rawClient().mode === "live", { mode: env.YOUTUBE_MODE, client: rawClient().mode });

  await withYouTubeContext(ctx, async () => {
    // 1. Resolution
    const r = await resolveChannelInput(input, {});
    ok("resolve channel input", r.status === "resolved", r.status === "resolved" ? { input, youtubeId: r.youtubeId, via: r.via } : r);
    if (r.status !== "resolved") return;

    // 2. channels.list (all parts) + normalization
    const [ch] = await youtube.getChannels({ ids: [r.youtubeId] });
    const nc = normalizeChannel(ch!);
    ok("channels.list returns the channel with all requested parts", Boolean(ch?.snippet && ch.statistics && ch.contentDetails && ch.brandingSettings && ch.status), {
      title: ch?.snippet?.title,
      parts: Object.keys(ch ?? {}).filter((k) => !["id", "etag", "kind"].includes(k)),
      videoCount: ch?.statistics?.videoCount?.toString(),
      hiddenSubscribers: ch?.statistics?.hiddenSubscriberCount,
      thumbnails: (nc.data.thumbnails as { variant: string; width: number | null }[]).map((t) => `${t.variant}:${t.width}`),
      coverage: Object.fromEntries(nc.coverage.map((g) => [g.group, g.status])),
    });
    const uploads = ch?.contentDetails?.relatedPlaylists?.uploads;
    ok("uploads playlist identified", Boolean(uploads), { uploads });
    if (!uploads) return;

    // 3. playlistItems.list pagination
    const p1 = await youtube.getPlaylistItems(uploads);
    const p2 = p1.nextPageToken ? await youtube.getPlaylistItems(uploads, p1.nextPageToken) : null;
    const ids = [...p1.items, ...(p2?.items ?? [])].map((i) => i.videoId);
    ok("playlistItems.list paginates (2 pages, distinct ids, newest first)", Boolean(p2) && new Set(ids).size === ids.length && p1.items.length === 50, {
      page1: p1.items.length,
      page2: p2?.items.length,
      totalResults: p1.totalResults,
      newest: p1.items[0]?.publishedAt,
      privacy: count([...p1.items, ...(p2?.items ?? [])], (i) => i.privacyStatus ?? "none"),
    });

    // 4. Batched videos.list + normalization/coverage
    const vids = await youtube.getVideos(ids);
    const norm = vids.map((v) => normalizeVideo(v));
    const stat = (k: string) => count(norm, (n) => String((n.coverage.find((g) => g.group === "STATISTICS")?.details as Record<string, string> | undefined)?.[k] ?? "n/a"));
    ok("videos.list batches (≤ 50 ids per call) and returns full metadata", vids.length > 50 && vids.every((v) => v.snippet && v.contentDetails && v.statistics && v.status), {
      requested: ids.length,
      returned: vids.length,
      notReturned: ids.filter((id) => !vids.some((v) => v.id === id)).length,
      thumbnailVariants: count(norm.flatMap((n) => (n.data.thumbnails as { variant: string }[]).map((t) => t.variant)), (x) => x),
      views: stat("views"),
      likes: stat("likes"),
      comments: stat("comments"),
      liveBroadcast: count(vids, (v) => v.snippet?.liveBroadcastContent ?? "none"),
      definition: count(vids, (v) => v.contentDetails?.definition ?? "?"),
      captionFlag: count(vids, (v) => v.contentDetails?.caption ?? "?"),
      audioLanguage: count(vids, (v) => v.snippet?.defaultAudioLanguage ?? "unset"),
      withTags: vids.filter((v) => v.snippet?.tags?.length).length,
      withTopicCategories: vids.filter((v) => v.topicDetails?.topicCategories?.length).length,
      withLiveDetails: vids.filter((v) => v.liveStreamingDetails).length,
      sample: { id: vids[0]?.id, title: vids[0]?.snippet?.title, duration: vids[0]?.contentDetails?.duration, views: vids[0]?.statistics?.viewCount?.toString() },
      allGroupsResolved: norm.every((n) => n.coverage.filter((g) => ["IDENTITY", "TEXT", "PUBLICATION", "THUMBNAILS", "STATISTICS"].includes(g.group)).every((g) => ["PRESENT", "UNAVAILABLE", "NOT_APPLICABLE"].includes(g.status))),
    });

    // 4b. Discovery (search.list) — opt-in because it spends 1 of the 100 daily searches.
    const si = process.argv.indexOf("--search");
    if (si > 0 && process.argv[si + 1]) {
      const hits = await youtube.searchChannels({ q: process.argv[si + 1]!, maxResults: 5 });
      const details = await youtube.getChannels({ ids: hits.map((h) => h.channelId) });
      ok("search.list discovery returns channels, enriched via channels.list", hits.length > 0 && details.length === hits.length, {
        query: process.argv[si + 1],
        results: details.map((d) => ({ id: d.id, title: d.snippet?.title, videos: d.statistics?.videoCount?.toString() })),
      });
    }

    // 5. Error handling
    const none = await youtube.getVideos(["AAAAAAAAAAA"]);
    ok("unknown video id → empty result (not an error)", none.length === 0);
    const noCh = await youtube.getChannels({ ids: ["UCAAAAAAAAAAAAAAAAAAAAAA"] });
    ok("unknown channel id → empty result", noCh.length === 0);
    try {
      await youtube.getPlaylistItems("UUAAAAAAAAAAAAAAAAAAAAAA");
      ok("missing playlist → playlistNotFound error", false);
    } catch (e) {
      ok("missing playlist → typed YouTubeApiError (non-retryable 404)", e instanceof YouTubeApiError && e.status === 404 && !e.retryable, e instanceof YouTubeApiError ? { status: e.status, reason: e.reason } : String(e));
    }
  });

  // Invalid key → typed error (unmetered raw call against a throwaway client; does not use the real key).
  try {
    await new LiveYouTubeClient("invalid-key-for-smoke-test").channelsList({ ids: ["UCYO_jab_esuFRV4b17AJtAw"] });
    ok("invalid API key rejected", false);
  } catch (e) {
    ok("invalid API key → typed non-retryable error", e instanceof YouTubeApiError && e.status === 400 && !e.retryable, e instanceof YouTubeApiError ? { status: e.status, reason: e.reason } : String(e));
  }

  const after = await usage();
  const g = (u: typeof before, b: string) => u.buckets.find((x) => x.bucket === b)!.used;
  const metered = (b: string) => Object.values(tally).reduce((a, t) => a + (t.bucket === b ? t.units : 0), 0);
  ok("quota accounting matches metered calls", g(after, "general") - g(before, "general") === metered("general") && g(after, "search") - g(before, "search") === metered("search"), {
    perMethod: tally,
    generalUnitsSpent: g(after, "general") - g(before, "general"),
    searchCallsSpent: g(after, "search") - g(before, "search"),
    todayAfter: after.buckets.map((b) => `${b.bucket} ${b.used}/${b.limit}`),
    resetAt: after.resetAt,
  });
  const failed = (out.checks as { pass: boolean }[]).filter((c) => !c.pass).length;
  console.log(`\n${failed ? `${failed} check(s) FAILED` : "all checks passed"} · ${new Date().toISOString()}`);
  if (process.argv.includes("--json")) console.log(JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : e);
  process.exitCode = 1;
} finally {
  await redis.quit();
  await db.$disconnect();
}
