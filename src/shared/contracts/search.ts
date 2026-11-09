import { z } from "zod";
import { csv, Cursor } from "./common";

export const SEARCH_TYPES = ["channel", "video", "topic", "transcript", "niche"] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];
export type SearchMode = "hybrid" | "keyword" | "semantic";

export const SearchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  mode: z.enum(["hybrid", "keyword", "semantic"]).default("hybrid"),
  types: csv(z.enum(SEARCH_TYPES)),
  channelId: z.string().max(100).optional(),
  /** "mine" limits transcript hits to the signed-in user's own private transcripts (D11). */
  transcripts: z.enum(["all", "mine"]).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: Cursor,
});

export const SuggestQuery = z.object({ q: z.string().trim().min(1).max(100), limit: z.coerce.number().int().min(1).max(20).default(6) });

export interface SearchHit {
  type: SearchType;
  id: string;
  nodeId: string;
  title: string;
  subtitle: string | null;
  /** May contain <mark>…</mark> highlight tags only; render via the safe highlighter. */
  snippet: string | null;
  thumbnailUrl: string | null;
  url: string | null;
  score: number;
  meta?: Record<string, unknown>;
  chunks?: { chunkId: string; startSec: number; endSec: number; text: string; url: string }[];
}

export interface SuggestItem {
  type: "channel" | "video" | "topic" | "niche";
  id: string;
  nodeId: string;
  label: string;
  sublabel: string | null;
  thumbnailUrl: string | null;
  score: number;
}
