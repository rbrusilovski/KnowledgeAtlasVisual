/**
 * YouTube Data API v3 quota costs — the ONE place these numbers live (spec §3).
 * Verified against Google's docs (Nov 2026). Two models for search.list:
 *  - "bucket": search.list has its own bucket (100 calls/day), 1 call each  (current docs)
 *  - "shared": search.list costs 100 units from the general pool             (older docs)
 */
import { env } from "../env";

export type QuotaBucket = "general" | "search";
export type YouTubeMethod =
  | "channels.list"
  | "videos.list"
  | "playlistItems.list"
  | "channelSections.list"
  | "videoCategories.list"
  | "search.list"
  | "captions.list"
  | "captions.download";

export interface Cost {
  bucket: QuotaBucket;
  units: number;
}

const GENERAL_COSTS: Record<Exclude<YouTubeMethod, "search.list">, number> = {
  "channels.list": 1,
  "videos.list": 1,
  "playlistItems.list": 1,
  "channelSections.list": 1,
  "videoCategories.list": 1,
  "captions.list": 50,
  "captions.download": 200,
};

/** Legacy shared-pool price of a search call. */
export const SEARCH_SHARED_UNITS = 100;

export function costOf(method: YouTubeMethod, model = env.QUOTA_SEARCH_MODEL): Cost {
  if (method === "search.list") {
    return model === "bucket" ? { bucket: "search", units: 1 } : { bucket: "general", units: SEARCH_SHARED_UNITS };
  }
  return { bucket: "general", units: GENERAL_COSTS[method] };
}

export function bucketLimits(): Record<QuotaBucket, number> {
  return { general: env.QUOTA_GENERAL_UNITS_PER_DAY, search: env.QUOTA_SEARCH_CALLS_PER_DAY };
}

/** Quota resets at midnight Pacific Time. */
export const QUOTA_TIMEZONE = "America/Los_Angeles";

/** Page sizes imposed by the API. */
export const MAX_PAGE_SIZE = 50;
export const MAX_IDS_PER_CALL = 50;

/** Redis response-cache TTLs (seconds), spec §7.2. */
export const CACHE_TTL = {
  search: 24 * 3600,
  channel: 6 * 3600,
  uploadsFirstPage: 30 * 60,
  uploadsPage: 6 * 3600,
  videoStats: 6 * 3600,
  channelSections: 6 * 3600,
  resolution: 30 * 24 * 3600,
  /** Extra stale-while-revalidate windows for reads that power the UI. */
  channelSwr: 3600,
  uploadsFirstPageSwr: 15 * 60,
  videoStatsSwr: 3600,
} as const;
