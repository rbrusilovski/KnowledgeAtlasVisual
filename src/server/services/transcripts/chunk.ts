import type { Cue } from "./parse";

export interface Chunk {
  idx: number;
  startSec: number;
  endSec: number;
  text: string;
}

/** Rough token estimate (~0.75 words per token for English). */
export const estimateTokens = (s: string) => Math.ceil((s.match(/\S+/g)?.length ?? 0) / 0.75);

/**
 * Merge cues into ~250–400-token chunks with ~15% overlap (by cues), keeping timestamps.
 * A single oversized cue becomes its own chunk.
 */
export function chunkCues(cues: Cue[], opts: { target?: number; max?: number; overlap?: number } = {}): Chunk[] {
  const target = opts.target ?? 320;
  const max = opts.max ?? 400;
  const overlap = opts.overlap ?? 0.15;
  const chunks: Chunk[] = [];
  let i = 0;
  while (i < cues.length) {
    const start = i;
    let tokens = 0;
    while (i < cues.length) {
      const t = estimateTokens(cues[i]!.text);
      if (i > start && tokens + t > max) break;
      tokens += t;
      i++;
      if (tokens >= target) break;
    }
    const slice = cues.slice(start, i);
    chunks.push({
      idx: chunks.length,
      startSec: slice[0]!.start,
      endSec: slice[slice.length - 1]!.end,
      text: slice.map((c) => c.text).join(" "),
    });
    if (i >= cues.length) break;
    // Step back so the next chunk re-includes ~15% of this one's tokens.
    let back = 0;
    let j = i;
    while (j - 1 > start && back < tokens * overlap) {
      j--;
      back += estimateTokens(cues[j]!.text);
    }
    i = j > start ? j : i;
  }
  return chunks;
}

export function timestampUrl(videoYoutubeId: string, startSec: number) {
  return `https://www.youtube.com/watch?v=${videoYoutubeId}&t=${Math.floor(startSec)}s`;
}
