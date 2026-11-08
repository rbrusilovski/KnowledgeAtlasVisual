import { describe, expect, it } from "vitest";
import { LiveYouTubeClient } from "@/server/youtube/live";
import { YouTubeApiError } from "@/server/youtube/types";

type Handler = (u: URL) => Response;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const routes: Record<string, Handler> = {
  channels: (u) => {
    if (u.searchParams.get("key") !== "test-key") return json({ error: { code: 400, message: "bad key", errors: [{ reason: "keyInvalid" }] } }, 400);
    if (u.searchParams.get("forHandle") === "quota") return json({ error: { code: 403, message: "exceeded", errors: [{ reason: "quotaExceeded" }] } }, 403);
    expect(u.searchParams.get("fields")).toContain("items(id");
    return json({
      items: [
        {
          id: "UCSkce29rCKQIIQVOKKuihmk",
          snippet: { title: "Chan", description: "d", customUrl: "@chan" },
          statistics: { subscriberCount: "1234", videoCount: "5", viewCount: "99", hiddenSubscriberCount: false },
          contentDetails: { relatedPlaylists: { uploads: "UUSkce29rCKQIIQVOKKuihmk" } },
          extraneous: { ignored: true },
        },
      ],
    });
  },
  playlistItems: () => json({ nextPageToken: "NEXT", pageInfo: { totalResults: 120 }, items: [{ contentDetails: { videoId: "dQw4w9WgXcQ", videoPublishedAt: "2026-01-01T00:00:00Z" } }] }),
  videos: () => new Response("upstream down", { status: 503 }),
};
const calls: string[] = [];
/** In-memory transport: guarantees no real network traffic. */
const fakeFetch = (async (input: string | URL | Request) => {
  const u = new URL(String(input instanceof Request ? input.url : input));
  calls.push(u.pathname);
  const name = u.pathname.split("/").pop()!;
  const h = routes[name];
  if (!h) throw new Error(`unexpected request ${u}`);
  return h(u);
}) as typeof fetch;

describe("LiveYouTubeClient", () => {
  const client = new LiveYouTubeClient("test-key", fakeFetch);

  it("parses channels and coerces counts to BigInt", async () => {
    const [c] = await client.channelsList({ forHandle: "chan" });
    expect(c!.statistics!.subscriberCount).toBe(1234n);
    expect(c!.contentDetails!.relatedPlaylists!.uploads).toBe("UUSkce29rCKQIIQVOKKuihmk");
    expect(c).not.toHaveProperty("extraneous");
  });

  it("maps quotaExceeded to a non-retryable quota error", async () => {
    const err = await client.channelsList({ forHandle: "quota" }).catch((e) => e);
    expect(err).toBeInstanceOf(YouTubeApiError);
    expect(err.isQuotaExceeded).toBe(true);
    expect(err.retryable).toBe(false);
  });

  it("pages playlist items", async () => {
    const page = await client.playlistItemsList("UUSkce29rCKQIIQVOKKuihmk");
    expect(page).toEqual({ items: [{ videoId: "dQw4w9WgXcQ", publishedAt: "2026-01-01T00:00:00Z" }], nextPageToken: "NEXT", totalResults: 120 });
  });

  it("marks 5xx as retryable", async () => {
    const err = await client.videosList(["dQw4w9WgXcQ"]).catch((e) => e);
    expect(err.status).toBe(503);
    expect(err.retryable).toBe(true);
  });

  it("validates batch size before calling (no wasted units)", async () => {
    const before = calls.length;
    await expect(client.videosList(Array.from({ length: 51 }, (_, i) => `v${String(i).padStart(10, "0")}`))).rejects.toThrow(/≤ 50/);
    expect(calls.length).toBe(before);
  });
});
