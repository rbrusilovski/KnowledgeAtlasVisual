/** Live client: requested parts/fields, full real-shaped responses, unknown fields, partial responses (no network). */
import { describe, expect, it } from "vitest";
import { LiveYouTubeClient } from "@/server/youtube/live";
import { normalizeChannel, normalizeVideo } from "@/server/youtube/normalize";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const seen: URL[] = [];

const VIDEO = {
  kind: "youtube#video",
  etag: "e-v1",
  id: "dQw4w9WgXcQ",
  snippet: {
    publishedAt: "2026-03-01T12:00:00Z",
    channelId: "UCSkce29rCKQIIQVOKKuihmk",
    channelTitle: "Chan",
    title: "Live Q&A",
    description: "desc",
    thumbnails: {
      default: { url: "https://i.ytimg.com/vi/x/default.jpg", width: 120, height: 90 },
      medium: { url: "https://i.ytimg.com/vi/x/mqdefault.jpg", width: 320, height: 180 },
      high: { url: "https://i.ytimg.com/vi/x/hqdefault.jpg", width: 480, height: 360 },
      standard: { url: "https://i.ytimg.com/vi/x/sddefault.jpg", width: 640, height: 480 },
      maxres: { url: "https://i.ytimg.com/vi/x/maxresdefault.jpg", width: 1280, height: 720 },
    },
    tags: ["a", "b"],
    categoryId: "27",
    liveBroadcastContent: "none",
    defaultLanguage: "en",
    localized: { title: "Live Q&A", description: "desc" },
    defaultAudioLanguage: "en-US",
    someFutureField: 1,
  },
  contentDetails: { duration: "PT1H2M3S", dimension: "2d", definition: "hd", caption: "true", licensedContent: true, contentRating: {}, projection: "rectangular", regionRestriction: { blocked: ["DE"] } },
  status: { uploadStatus: "processed", privacyStatus: "public", license: "creativeCommon", embeddable: true, publicStatsViewable: true, madeForKids: false },
  statistics: { viewCount: "1000", likeCount: "10", favoriteCount: "0", commentCount: "3" },
  topicDetails: { topicCategories: ["https://en.wikipedia.org/wiki/Knowledge"] },
  liveStreamingDetails: { actualStartTime: "2026-03-01T12:00:00Z", actualEndTime: "2026-03-01T13:02:03Z", scheduledStartTime: "2026-03-01T11:55:00Z" },
  localizations: { de: { title: "Live-Fragen", description: "Beschreibung" } },
};

const fakeFetch = (async (input: string | URL | Request) => {
  const u = new URL(String(input instanceof Request ? input.url : input));
  seen.push(u);
  const name = u.pathname.split("/").pop();
  if (name === "videos") {
    if (u.searchParams.get("id") === "partialxxxx") return json({ items: [{ id: "partialxxxx", etag: "p", snippet: { channelId: "UCSkce29rCKQIIQVOKKuihmk", title: "P", publishedAt: "2026-01-01T00:00:00Z" } }] });
    return json({ items: [VIDEO] });
  }
  if (name === "channels")
    return json({
      items: [
        {
          id: "UCSkce29rCKQIIQVOKKuihmk",
          etag: "e-c1",
          snippet: { title: "Chan", description: "", customUrl: "@chan", publishedAt: "2015-01-01T00:00:00Z", defaultLanguage: "en", thumbnails: { default: { url: "a", width: 88, height: 88 }, medium: { url: "b", width: 240, height: 240 }, high: { url: "c", width: 800, height: 800 } } },
          statistics: { viewCount: "99", hiddenSubscriberCount: true, videoCount: "5" },
          contentDetails: { relatedPlaylists: { uploads: "UUSkce29rCKQIIQVOKKuihmk", likes: "" } },
          brandingSettings: { channel: { keywords: "science \"deep space\"", unsubscribedTrailer: "dQw4w9WgXcQ", country: "GB" } },
          topicDetails: { topicIds: ["/m/01k8wb"], topicCategories: ["https://en.wikipedia.org/wiki/Knowledge"] },
          status: { privacyStatus: "public", isLinked: true, madeForKids: false, longUploadsStatus: "allowed" },
        },
      ],
    });
  if (name === "playlistItems") return json({ items: [{ contentDetails: { videoId: "dQw4w9WgXcQ", videoPublishedAt: "2026-03-01T12:00:00Z" }, status: { privacyStatus: "public" } }], pageInfo: { totalResults: 1 } });
  throw new Error(`unexpected ${u}`);
}) as typeof fetch;

describe("LiveYouTubeClient — full metadata parts", () => {
  const client = new LiveYouTubeClient("k", fakeFetch);

  it("requests every useful part in one 1-unit call (no extra quota per part)", async () => {
    await client.videosList(["dQw4w9WgXcQ"]);
    await client.channelsList({ ids: ["UCSkce29rCKQIIQVOKKuihmk"] });
    await client.playlistItemsList("UUSkce29rCKQIIQVOKKuihmk");
    const v = seen.find((u) => u.pathname.endsWith("/videos"))!;
    expect(v.searchParams.get("part")!.split(",").sort()).toEqual(["contentDetails", "liveStreamingDetails", "localizations", "snippet", "statistics", "status", "topicDetails"]);
    expect(v.searchParams.get("fields")).toContain("thumbnails");
    const c = seen.find((u) => u.pathname.endsWith("/channels"))!;
    expect(c.searchParams.get("part")!.split(",")).toEqual(expect.arrayContaining(["snippet", "statistics", "contentDetails", "brandingSettings", "topicDetails", "status", "localizations"]));
    expect(seen.find((u) => u.pathname.endsWith("/playlistItems"))!.searchParams.get("part")).toBe("contentDetails,status");
  });

  it("parses and normalizes a full video, ignoring unknown fields", async () => {
    const [v] = await client.videosList(["dQw4w9WgXcQ"]);
    const { data, coverage } = normalizeVideo(v!);
    expect(data).toMatchObject({
      channelTitle: "Chan",
      durationSec: 3723,
      defaultAudioLanguage: "en-US",
      definition: "hd",
      captionFlag: true,
      licensedContent: true,
      license: "creativeCommon",
      contentRating: null, // empty object = no rating
      regionRestriction: { blocked: ["DE"] },
      topicCategories: ["https://en.wikipedia.org/wiki/Knowledge"],
      viewCount: 1000n,
      likeCount: 10n,
      commentCount: 3n,
    });
    expect((data.thumbnails as unknown[]).length).toBe(5);
    expect(data.thumbnailUrl).toBe("https://i.ytimg.com/vi/x/hqdefault.jpg");
    expect((data.liveActualEndAt as Date).toISOString()).toBe("2026-03-01T13:02:03.000Z");
    expect(data.localizations).toEqual({ de: { title: "Live-Fragen", description: "Beschreibung" } });
    expect(coverage.every((g) => g.status === "PRESENT")).toBe(true);
  });

  it("normalizes a full channel: hidden subscribers, branding country, trailer, topic ids", async () => {
    const [c] = await client.channelsList({ ids: ["UCSkce29rCKQIIQVOKKuihmk"] });
    const { data } = normalizeChannel(c!);
    expect(data).toMatchObject({ subscriberCount: null, hiddenSubscriberCount: true, country: "GB", trailerVideoId: "dQw4w9WgXcQ", topicIds: ["/m/01k8wb"], keywords: ["science", "deep space"], isLinked: true, defaultLanguage: "en" });
  });

  it("a partial response yields only the returned parts' columns", async () => {
    const [v] = await client.videosList(["partialxxxx"]);
    const { data, coverage } = normalizeVideo(v!);
    for (const k of ["viewCount", "likeCount", "durationSec", "privacyStatus"]) expect(k in data).toBe(false);
    expect(coverage.filter((g) => g.status === "NOT_RETURNED").map((g) => g.group).sort()).toEqual(["PUBLICATION", "STATISTICS", "STATUS"]);
  });

  it("carries playlist item privacy status", async () => {
    const p = await client.playlistItemsList("UUSkce29rCKQIIQVOKKuihmk");
    expect(p.items[0]).toMatchObject({ videoId: "dQw4w9WgXcQ", privacyStatus: "public" });
    expect(p.totalResults).toBe(1);
  });
});
