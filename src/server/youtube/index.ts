import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { log } from "@/server/logger";
import * as quota from "@/server/services/quota";
import { cached } from "@/server/services/cache";
import { publish } from "@/server/services/realtime";
import { CACHE_TTL, costOf, MAX_IDS_PER_CALL, type YouTubeMethod } from "./costs";
import { LiveYouTubeClient } from "./live";
import { FixtureYouTubeClient } from "./fixture";
import { YouTubeApiError, type RawYouTubeClient, type SearchChannelsParams } from "./types";

export * from "./types";
export { parseIsoDuration, bestThumb, type YtChannel, type YtVideo } from "./schemas";
export { costOf, bucketLimits, CACHE_TTL } from "./costs";

export interface YouTubeCallContext {
  lane: quota.Lane;
  /** Accumulates spend into the current IngestionRun. */
  onCost?: (method: YouTubeMethod, bucket: string, units: number) => void;
  /** Skip the response cache (e.g. compliance refresh must hit the API). */
  noCache?: boolean;
}

const ctx = new AsyncLocalStorage<YouTubeCallContext>();

export function withYouTubeContext<T>(c: YouTubeCallContext, fn: () => Promise<T>): Promise<T> {
  return ctx.run(c, fn);
}

function current(): YouTubeCallContext {
  return ctx.getStore() ?? { lane: "interactive" };
}

let raw: RawYouTubeClient | null = null;
export function rawClient(): RawYouTubeClient {
  if (!raw) raw = env.YOUTUBE_MODE === "live" ? new LiveYouTubeClient(env.YOUTUBE_API_KEY!) : new FixtureYouTubeClient();
  return raw;
}
/** Tests may inject a transport. */
export function setRawClient(c: RawYouTubeClient | null) {
  raw = c;
}

export const youtubeMode = () => env.YOUTUBE_MODE;

/** Reserve quota, call, account. Even fixture mode meters quota so the UI reflects realistic spend. */
async function metered<T>(method: YouTubeMethod, fn: () => Promise<T>): Promise<T> {
  const c = current();
  const cost = costOf(method);
  const r = await quota.reserve(cost.bucket, cost.units, c.lane);
  if (!r.ok) {
    const what = cost.bucket === "search" ? "YouTube search quota" : "YouTube API quota";
    throw new AppError(
      "QUOTA_EXHAUSTED",
      r.reason === "background_budget"
        ? `Background ${what} budget reached; reserved for interactive use.`
        : `${what} exhausted for today. Resets at midnight Pacific.`,
      { bucket: cost.bucket, reason: r.reason, used: r.used, limit: r.limit, resetAt: r.resetAt.toISOString(), lane: c.lane },
      { "Retry-After": String(quota.secondsUntilReset()) },
    );
  }
  c.onCost?.(method, cost.bucket, cost.units);
  void quota.recordCall(method, cost.bucket, cost.units).catch(() => undefined);
  void publish({ type: "quota.updated", scope: "global", payload: { bucket: cost.bucket, used: r.used, limit: r.limit } }).catch(() => undefined);
  try {
    return await fn();
  } catch (err) {
    if (err instanceof YouTubeApiError && err.isQuotaExceeded) {
      const resetAt = await quota.markExhausted(cost.bucket);
      log().warn({ method, bucket: cost.bucket }, "YouTube reported quotaExceeded; bucket marked exhausted");
      void publish({ type: "quota.updated", scope: "global", payload: { bucket: cost.bucket, exhausted: true } }).catch(() => undefined);
      throw new AppError("QUOTA_EXHAUSTED", "YouTube API quota exhausted for today.", { bucket: cost.bucket, resetAt: resetAt.toISOString() }, { "Retry-After": String(quota.secondsUntilReset()) });
    }
    throw err;
  }
}

function maybeCached<T>(ns: string, params: unknown, ttlSec: number, fn: () => Promise<T>, swrSec?: number): Promise<T> {
  if (current().noCache) return fn();
  return cached(`yt:${env.YOUTUBE_MODE}:${ns}`, params, { ttlSec, swrSec }, fn);
}

const UC_ID = /^UC[A-Za-z0-9_-]{22}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** The metered, cached YouTube client. All server code goes through this. */
export const youtube = {
  async getChannels(p: { ids?: string[]; forHandle?: string; forUsername?: string }) {
    if (p.ids) {
      const ids = [...new Set(p.ids)].filter((id) => UC_ID.test(id));
      if (!ids.length) return [];
      const out = [];
      for (let i = 0; i < ids.length; i += MAX_IDS_PER_CALL) {
        const batch = ids.slice(i, i + MAX_IDS_PER_CALL).sort();
        out.push(...(await maybeCached("channels", { ids: batch }, CACHE_TTL.channel, () => metered("channels.list", () => rawClient().channelsList({ ids: batch })))));
      }
      return out;
    }
    const handle = p.forHandle?.replace(/^@/, "").toLowerCase();
    if (handle !== undefined) {
      if (!/^[\p{L}\p{N}._-]{3,30}$/u.test(handle)) return [];
      return maybeCached("channels", { forHandle: handle }, CACHE_TTL.channel, () => metered("channels.list", () => rawClient().channelsList({ forHandle: handle })));
    }
    if (p.forUsername) {
      const u = p.forUsername.toLowerCase();
      if (!/^[a-z0-9]{1,40}$/i.test(u)) return [];
      return maybeCached("channels", { forUsername: u }, CACHE_TTL.channel, () => metered("channels.list", () => rawClient().channelsList({ forUsername: u })));
    }
    return [];
  },

  async getPlaylistItems(playlistId: string, pageToken?: string) {
    if (!/^[A-Za-z0-9_-]{10,64}$/.test(playlistId)) throw new AppError("VALIDATION_ERROR", "Invalid playlist id");
    const ttl = pageToken ? CACHE_TTL.uploadsPage : CACHE_TTL.uploadsFirstPage;
    return maybeCached("playlistItems", { playlistId, pageToken }, ttl, () => metered("playlistItems.list", () => rawClient().playlistItemsList(playlistId, pageToken)));
  },

  async getVideos(ids: string[]) {
    const valid = [...new Set(ids)].filter((id) => VIDEO_ID.test(id));
    const out = [];
    for (let i = 0; i < valid.length; i += MAX_IDS_PER_CALL) {
      const batch = valid.slice(i, i + MAX_IDS_PER_CALL).sort();
      out.push(...(await maybeCached("videos", { ids: batch }, CACHE_TTL.videoStats, () => metered("videos.list", () => rawClient().videosList(batch)))));
    }
    return out;
  },

  async getChannelSections(channelId: string) {
    if (!UC_ID.test(channelId)) return [];
    return maybeCached("channelSections", { channelId }, CACHE_TTL.channelSections, () => metered("channelSections.list", () => rawClient().channelSectionsList(channelId)));
  },

  async searchChannels(p: SearchChannelsParams) {
    const q = p.q.trim().slice(0, 200);
    if (!q) throw new AppError("VALIDATION_ERROR", "Search query is empty");
    const params = { ...p, q, maxResults: Math.min(p.maxResults ?? 25, 50) };
    return maybeCached("search", params, CACHE_TTL.search, () => metered("search.list", () => rawClient().searchChannels(params)));
  },

  /** Only for channels the user owns (OAuth). Never call speculatively: 50 units. */
  async listCaptions(videoId: string, accessToken: string) {
    if (!VIDEO_ID.test(videoId)) throw new AppError("VALIDATION_ERROR", "Invalid video id");
    return metered("captions.list", () => rawClient().captionsList(videoId, accessToken));
  },

  async downloadCaption(captionId: string, accessToken: string) {
    return metered("captions.download", () => rawClient().captionsDownload(captionId, accessToken));
  },

  /** Would a search right now be served from cache (i.e. free)? */
  isUcId: (s: string) => UC_ID.test(s),
  isVideoId: (s: string) => VIDEO_ID.test(s),
};

export type YouTube = typeof youtube;
