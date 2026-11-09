import { afterEach, describe, expect, it } from "vitest";
import { normalizeChannel, normalizeVideo, thumbnailVariants, handleFrom } from "@/server/youtube/normalize";
import { ytChannel, ytVideo } from "@/server/youtube/schemas";
import { estimate, normalizeScope, scopeHash } from "@/server/services/expansion";
import { deadlineFrom, effectiveStatus, retentionDays } from "@/server/services/coverage";
import { env } from "@/server/env";
import { allowed, policyStatus } from "@/server/youtube/policy";
import { fixtureRoll } from "@/server/youtube/fixture";

const fullVideo = ytVideo.parse({
  id: "abcdefghijk",
  etag: "e1",
  snippet: {
    channelId: "UCaaaaaaaaaaaaaaaaaaaaaa",
    channelTitle: "Chan",
    title: "T",
    description: "",
    publishedAt: "2026-01-02T03:04:05Z",
    defaultAudioLanguage: "en",
    liveBroadcastContent: "none",
    thumbnails: { default: { url: "d", width: 120, height: 90 }, high: { url: "h", width: 480, height: 360 }, maxres: { url: "m", width: 1280, height: 720 } },
  },
  contentDetails: { duration: "PT1M1S", caption: "false", definition: "hd" },
  statistics: { viewCount: "10", commentCount: "0" },
  status: { privacyStatus: "public", publicStatsViewable: true },
});

describe("normalization", () => {
  it("keeps every thumbnail variant with dimensions and picks a preferred display variant", () => {
    expect(thumbnailVariants(fullVideo.snippet!.thumbnails)).toEqual([
      { variant: "default", url: "d", width: 120, height: 90 },
      { variant: "high", url: "h", width: 480, height: 360 },
      { variant: "maxres", url: "m", width: 1280, height: 720 },
    ]);
    expect(normalizeVideo(fullVideo).data.thumbnailUrl).toBe("h");
  });

  it("distinguishes hidden/disabled statistics from zero", () => {
    const { data, coverage } = normalizeVideo(fullVideo);
    expect(data).toMatchObject({ viewCount: 10n, likeCount: null, commentCount: 0n, captionFlag: false, durationSec: 61, isShort: false });
    const stats = coverage.find((g) => g.group === "STATISTICS")!;
    expect(stats.status).toBe("PRESENT");
    expect(stats.details).toMatchObject({ views: "PRESENT", likes: "HIDDEN", comments: "PRESENT" });
  });

  it("marks statistics UNAVAILABLE when the owner hides them", () => {
    const v = ytVideo.parse({ ...fullVideo, statistics: {}, status: { publicStatsViewable: false } });
    expect(normalizeVideo(v).coverage.find((g) => g.group === "STATISTICS")).toMatchObject({ status: "UNAVAILABLE", reason: "owner hid public statistics" });
  });

  it("omits columns of parts that were not returned (partial response) and reports NOT_RETURNED", () => {
    const { statistics: _s, contentDetails: _c, ...rest } = fullVideo;
    const { data, coverage } = normalizeVideo(ytVideo.parse(rest));
    expect("viewCount" in data).toBe(false);
    expect("durationSec" in data).toBe(false);
    expect(coverage.find((g) => g.group === "STATISTICS")!.status).toBe("NOT_RETURNED");
    expect(coverage.find((g) => g.group === "PUBLICATION")!.status).toBe("NOT_RETURNED");
    expect(coverage.find((g) => g.group === "TEXT")!.status).toBe("PRESENT");
  });

  it("normalizes channels: hidden subscribers, handle, keywords, unavailable country", () => {
    const c = ytChannel.parse({
      id: "UCaaaaaaaaaaaaaaaaaaaaaa",
      snippet: { title: "C", customUrl: "@Some.Handle", thumbnails: { medium: { url: "m" } } },
      statistics: { viewCount: "5", hiddenSubscriberCount: true, videoCount: "3" },
      contentDetails: { relatedPlaylists: { uploads: "UUaaaaaaaaaaaaaaaaaaaaaa" } },
      brandingSettings: { channel: { keywords: 'a "b c" a' } },
    });
    const { data, coverage } = normalizeChannel(c);
    expect(data).toMatchObject({ handle: "some.handle", subscriberCount: null, hiddenSubscriberCount: true, videoCount: 3, keywords: ["a", "b c"], uploadsPlaylistId: "UUaaaaaaaaaaaaaaaaaaaaaa", country: null });
    expect(coverage.find((g) => g.group === "STATISTICS")!.details).toMatchObject({ subscribers: "HIDDEN" });
    expect((coverage.find((g) => g.group === "CHANNEL_PROFILE")!.details as { country: string }).country).toBe("UNAVAILABLE");
    expect(coverage.find((g) => g.group === "STATUS")!.status).toBe("NOT_RETURNED");
    expect(handleFrom("legacyname")).toBeNull();
  });
});

describe("expansion scopes", () => {
  const add = (ids: string[], max = 100) => ({ kind: "ADD_CHANNELS", channels: ids.map((youtubeId) => ({ youtubeId, aliases: [] })), maxVideosPerChannel: max, includeTranscripts: true });
  const A = "UCaaaaaaaaaaaaaaaaaaaaaa";
  const B = "UCbbbbbbbbbbbbbbbbbbbbbb";

  it("hashes canonically: order and duplicates don't matter, any bound change does", () => {
    expect(scopeHash(normalizeScope(add([A, B])))).toBe(scopeHash(normalizeScope(add([B, A, A]))));
    expect(scopeHash(normalizeScope(add([A, B])))).not.toBe(scopeHash(normalizeScope(add([A, B], 101))));
    expect(scopeHash(normalizeScope(add([A])))).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects unbounded or malformed scopes", () => {
    expect(() => normalizeScope(add([A], 10_000))).toThrow();
    expect(() => normalizeScope(add(["not-a-channel"]))).toThrow();
    expect(() => normalizeScope({ kind: "DISCOVER_CHANNELS", queries: [], maxCandidatesPerQuery: 5, maxChannelsToAdd: 1, maxVideosPerChannel: 1 })).toThrow();
    expect(() => normalizeScope({ kind: "DELETE_EVERYTHING" })).toThrow();
  });

  it("estimates from central costs: known channels never use search", () => {
    const e = estimate(normalizeScope(add([A, B], 120)));
    expect(e).toMatchObject({ channels: 2, videos: 240, searchCalls: 0, quotaUnits: 2 * (1 + 3 + 3 + 1) });
    const d = estimate(normalizeScope({ kind: "DISCOVER_CHANNELS", queries: ["x", "y"], maxCandidatesPerQuery: 25, maxChannelsToAdd: 3, maxVideosPerChannel: 50 }));
    expect(d.searchCalls).toBe(2);
    expect(d.channels).toBe(3);
    expect(d.uncertainty).toMatch(/At most 3/);
    const b = estimate(normalizeScope({ kind: "BACKFILL_HISTORY", channelYoutubeId: A, maxPages: 4, maxVideos: 1000 }));
    expect(b).toMatchObject({ videos: 200, quotaUnits: 1 + 4 + 4 });
    const r = estimate(normalizeScope({ kind: "REFRESH_METADATA", channelYoutubeIds: [A], videoYoutubeIds: Array.from({ length: 51 }, (_, i) => `v${String(i).padStart(10, "0")}`), fields: "all", purpose: "compliance" }));
    expect(r.quotaUnits).toBe(1 + 2);
  });
});

describe("retention + policy", () => {
  afterEach(() => {
    (env as { YOUTUBE_MODE: string }).YOUTUBE_MODE = "fixture";
    (env as { YOUTUBE_DERIVED_METRICS_AMENDMENT_ACCEPTED: boolean }).YOUTUBE_DERIVED_METRICS_AMENDMENT_ACCEPTED = false;
  });

  it("uses 30 days for API data and never extends text metadata", () => {
    const t = new Date("2026-01-01T00:00:00Z");
    expect(deadlineFrom("API_METADATA", t)!.toISOString()).toBe("2026-01-31T00:00:00.000Z");
    expect(retentionDays("API_STATISTICS")).toBe(30);
    expect(retentionDays("USER_CONTENT")).toBeNull();
    (env as { YOUTUBE_MODE: string }).YOUTUBE_MODE = "live";
    (env as { YOUTUBE_DERIVED_METRICS_AMENDMENT_ACCEPTED: boolean }).YOUTUBE_DERIVED_METRICS_AMENDMENT_ACCEPTED = true;
    expect(retentionDays("API_STATISTICS")).toBe(36 * 30); // statistics only
    expect(retentionDays("API_METADATA")).toBe(30);
  });

  it("reports resolved data inside the lead window as STALE", () => {
    const soon = new Date(Date.now() + 2 * 86_400_000);
    expect(effectiveStatus({ status: "PRESENT", retentionDeadline: soon })).toBe("STALE");
    expect(effectiveStatus({ status: "PRESENT", retentionDeadline: new Date(Date.now() + 20 * 86_400_000) })).toBe("PRESENT");
    expect(effectiveStatus({ status: "NOT_RETURNED", retentionDeadline: soon })).toBe("NOT_RETURNED");
  });

  it("gates live collection, cross-owner aggregation and derived data off by default; fixture mode is open", () => {
    expect(policyStatus()).toMatchObject({ mode: "fixture", liveCollection: true, crossOwnerAggregation: true, derivedData: true });
    (env as { YOUTUBE_MODE: string }).YOUTUBE_MODE = "live";
    expect(allowed("live-collection")).toBe(false);
    expect(allowed("cross-owner-aggregation")).toBe(false);
    expect(allowed("derived-data")).toBe(false);
  });

  it("fixture variation is deterministic", () => {
    expect(fixtureRoll("abc", "likes")).toBe(fixtureRoll("abc", "likes"));
    expect(fixtureRoll("abc", "likes")).not.toBe(fixtureRoll("abd", "likes"));
  });
});
