import { z } from "zod";
import { boolish, Cursor, Limit } from "./common";

export const AddChannelBody = z.object({
  input: z.string().trim().min(1).max(300),
  /** Required to spend a search.list call resolving a legacy /c/custom URL. */
  confirm: z.boolean().optional(),
});
export type AddChannelBody = z.infer<typeof AddChannelBody>;

export const SyncChannelBody = z.object({ full: z.boolean().optional() });

export const ChannelListQuery = z.object({
  niche: z.string().max(80).optional(),
  minSubscribers: z.coerce.number().int().nonnegative().optional(),
  maxSubscribers: z.coerce.number().int().nonnegative().optional(),
  q: z.string().max(200).optional(),
  sort: z.enum(["subscribers", "recent", "title", "videos", "synced"]).default("subscribers"),
  limit: Limit,
  cursor: Cursor,
});

export const ChannelVideosQuery = z.object({
  q: z.string().max(200).optional(),
  sort: z.enum(["relevance", "recent", "views"]).default("recent"),
  publishedAfter: z.coerce.date().optional(),
  publishedBefore: z.coerce.date().optional(),
  duration: z.enum(["short", "lt10", "10to30", "gt30"]).optional(),
  minViews: z.coerce.number().int().nonnegative().optional(),
  maxViews: z.coerce.number().int().nonnegative().optional(),
  hasTranscript: boolish,
  limit: Limit,
  cursor: Cursor,
});
export type ChannelVideosQuery = z.infer<typeof ChannelVideosQuery>;

export const NicheOverrideBody = z.object({
  /** Subniche IDs or slugs; replaces manual assignments. Empty array clears overrides. */
  nicheIds: z.array(z.string().min(1).max(100)).max(5),
});

export interface ChannelSummary {
  id: string;
  youtubeId: string;
  nodeId: string;
  title: string;
  handle: string | null;
  thumbnailUrl: string | null;
  subscriberCount: number | null;
  videoCount: number | null;
  viewCount: number | null;
  niches: { id: string; slug: string; name: string; confidence: number; method: string; lowConfidence: boolean }[];
  latestVideoAt: string | null;
  lastSyncedAt: string | null;
}
