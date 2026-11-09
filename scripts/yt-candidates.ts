/**
 * pnpm yt:candidates @handle UC… … [--max 200] — READ-ONLY. Resolves candidate channels (cheap paths only, never
 * search), fetches their public stats and prints the exact ADD_CHANNELS scope + server-side estimates for a bounded
 * window and for full history. Writes nothing to the database; use the output to create a proposal for approval.
 */
import "dotenv/config";

const { redis } = await import("@/server/redis");
const { db } = await import("@/server/db");
const { youtube, withYouTubeContext } = await import("@/server/youtube");
const { resolveChannelInput } = await import("@/server/youtube/resolve");
const { estimate, normalizeScope } = await import("@/server/services/expansion");

const args = process.argv.slice(2);
const mi = args.indexOf("--max");
const max = mi >= 0 ? Number(args[mi + 1]) : 200;
const inputs = args.filter((a, i) => !a.startsWith("--") && !(mi >= 0 && i === mi + 1));
let units = 0;
try {
  const rows = await withYouTubeContext({ lane: "interactive", onCost: (_m, _b, u) => (units += u) }, async () => {
    const out: { input: string; id?: string; title?: string; videos?: number; subscribers?: string; country?: string | null; inAtlas?: boolean; error?: string }[] = [];
    const resolved: { input: string; id: string; inAtlas: boolean }[] = [];
    for (const input of inputs) {
      const r = await resolveChannelInput(input, {});
      if (r.status === "resolved") resolved.push({ input, id: r.youtubeId, inAtlas: r.inAtlas });
      else out.push({ input, error: r.status });
    }
    const chans = await youtube.getChannels({ ids: resolved.map((r) => r.id) });
    for (const r of resolved) {
      const c = chans.find((x) => x.id === r.id);
      out.push({ input: r.input, id: r.id, title: c?.snippet?.title, videos: c?.statistics?.videoCount !== undefined ? Number(c.statistics.videoCount) : undefined, subscribers: c?.statistics?.hiddenSubscriberCount ? "hidden" : c?.statistics?.subscriberCount?.toString(), country: c?.snippet?.country ?? null, inAtlas: r.inAtlas });
    }
    return out;
  });
  console.table(rows.map((r) => ({ input: r.input, id: r.id ?? r.error, title: r.title, videos: r.videos, subs: r.subscribers, country: r.country, inAtlas: r.inAtlas })));
  const ok = rows.filter((r) => r.id && !r.inAtlas);
  const totalVideos = ok.reduce((a, r) => a + (r.videos ?? 0), 0);
  const scope = (m: number) => normalizeScope({ kind: "ADD_CHANNELS", channels: ok.map((r) => ({ youtubeId: r.id!, aliases: [] })), maxVideosPerChannel: m, includeTranscripts: true });
  const fullMax = Math.min(5000, Math.max(...ok.map((r) => r.videos ?? 0), 1));
  const bounded = estimate(scope(max));
  const full = estimate(scope(fullMax));
  const pages = (n: number) => Math.ceil(n / 50);
  const exactFull = ok.reduce((a, r) => a + 1 + 2 * pages(r.videos ?? 0) + 1, 0);
  const exactBounded = ok.reduce((a, r) => a + 1 + 2 * pages(Math.min(max, r.videos ?? 0)) + 1, 0);
  console.log(JSON.stringify({
    channels: ok.length,
    reportedUploads: totalVideos,
    bounded: { maxVideosPerChannel: max, videosUpTo: ok.reduce((a, r) => a + Math.min(max, r.videos ?? 0), 0), serverEstimateUnits: bounded.quotaUnits, expectedUnits: exactBounded },
    fullHistory: { maxVideosPerChannel: fullMax, videosUpTo: totalVideos, serverEstimateUnits: full.quotaUnits, expectedUnits: exactFull },
    searchCalls: 0,
    unitsSpentPreparingThis: units,
  }, null, 2));
} finally {
  await redis.quit();
  await db.$disconnect();
}
