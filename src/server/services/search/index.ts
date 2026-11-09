/**
 * Search (spec §7.8): keyword (tsvector + ts_rank_cd + recency/popularity boosts + ts_headline), fuzzy
 * (pg_trgm), semantic (HNSW KNN), hybrid (Reciprocal Rank Fusion, k = 60), channel-scoped with facets, and
 * transcript hits grouped by video with timestamped deep links.
 */
import { db, Prisma } from "@/server/db";
import { embedQuery, getProvider } from "@/server/services/embeddings";
import { toVectorLiteral } from "@/server/db/vector";
import { decodeCursor, encodeCursor } from "@/server/http/cursor";
import type { SearchHit, SearchMode, SearchType, SuggestItem } from "@/shared/contracts/search";
import type { ChannelVideosQuery } from "@/shared/contracts/channels";

export const RRF_K = 60;

/** Semantic lists always return k items; drop weak matches so they can't pollute hybrid fusion. */
function minSimilarity(): number {
  return getProvider().name.startsWith("local") ? 0.28 : 0.05;
}
const HL = "StartSel=<mark>, StopSel=</mark>, MaxWords=28, MinWords=10, ShortWord=2, MaxFragments=2, FragmentDelimiter= … ";

/** Reciprocal Rank Fusion over ranked ID lists. */
export function rrf(lists: string[][], k = RRF_K): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  for (const list of lists) list.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1)));
  return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

const watchUrl = (id: string, t?: number) => `https://www.youtube.com/watch?v=${id}${t !== undefined ? `&t=${Math.floor(t)}s` : ""}`;
const channelUrl = (id: string) => `https://www.youtube.com/channel/${id}`;

interface Ranked {
  key: string; // `${type}:${id}`
  hit: SearchHit;
}

// ── Keyword ────────────────────────────────────────────────────────────────

async function keywordChannels(q: string, n: number): Promise<Ranked[]> {
  const rows = await db.$queryRaw<{ id: string; youtubeId: string; title: string; handle: string | null; thumbnailUrl: string | null; subs: bigint | null; hl: string; rank: number }[]>`
    SELECT id, "youtubeId", title, handle, "thumbnailUrl", "subscriberCount" AS subs,
      ts_headline('english', left(description, 2000), websearch_to_tsquery('english', ${q}), ${HL}) AS hl,
      ts_rank_cd("searchVector", websearch_to_tsquery('english', ${q})) * (1 + 0.05 * ln(1 + coalesce("subscriberCount", 0)::float)) AS rank
    FROM "Channel" WHERE "searchVector" @@ websearch_to_tsquery('english', ${q}) AND "isAvailable"
    ORDER BY rank DESC LIMIT ${n}`;
  return rows.map((r) => ({
    key: `channel:${r.id}`,
    hit: { type: "channel", id: r.id, nodeId: `channel:${r.youtubeId}`, title: r.title, subtitle: r.handle ? `@${r.handle}` : null, snippet: r.hl, thumbnailUrl: r.thumbnailUrl, url: channelUrl(r.youtubeId), score: r.rank, meta: { subscriberCount: r.subs === null ? null : Number(r.subs) } },
  }));
}

function videoFilters(f: VideoFilter): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`v."isAvailable"`];
  if (f.channelId) parts.push(Prisma.sql`v."channelId" = ${f.channelId}`);
  if (f.publishedAfter) parts.push(Prisma.sql`v."publishedAt" >= ${f.publishedAfter}`);
  if (f.publishedBefore) parts.push(Prisma.sql`v."publishedAt" <= ${f.publishedBefore}`);
  if (f.duration === "short") parts.push(Prisma.sql`v."isShort"`);
  if (f.duration === "lt10") parts.push(Prisma.sql`NOT v."isShort" AND v."durationSec" < 600`);
  if (f.duration === "10to30") parts.push(Prisma.sql`v."durationSec" BETWEEN 600 AND 1800`);
  if (f.duration === "gt30") parts.push(Prisma.sql`v."durationSec" > 1800`);
  if (f.minViews !== undefined) parts.push(Prisma.sql`v."viewCount" >= ${BigInt(f.minViews)}`);
  if (f.maxViews !== undefined) parts.push(Prisma.sql`v."viewCount" <= ${BigInt(f.maxViews)}`);
  if (f.hasTranscript !== undefined) parts.push(Prisma.sql`v."hasTranscript" = ${f.hasTranscript}`);
  return Prisma.join(parts, " AND ");
}

export interface VideoFilter {
  channelId?: string;
  publishedAfter?: Date;
  publishedBefore?: Date;
  duration?: "short" | "lt10" | "10to30" | "gt30";
  minViews?: number;
  maxViews?: number;
  hasTranscript?: boolean;
}

type VideoRow = { id: string; youtubeId: string; title: string; thumbnailUrl: string | null; publishedAt: Date; views: bigint | null; durationSec: number | null; hasTranscript: boolean; channelTitle: string; channelYt: string; hl?: string; rank: number };

function videoHit(r: VideoRow): Ranked {
  return {
    key: `video:${r.id}`,
    hit: {
      type: "video",
      id: r.id,
      nodeId: `video:${r.youtubeId}`,
      title: r.title,
      subtitle: r.channelTitle,
      snippet: r.hl ?? null,
      thumbnailUrl: r.thumbnailUrl,
      url: watchUrl(r.youtubeId),
      score: r.rank,
      meta: { publishedAt: r.publishedAt.toISOString(), viewCount: r.views === null ? null : Number(r.views), durationSec: r.durationSec, hasTranscript: r.hasTranscript, channelNodeId: `channel:${r.channelYt}` },
    },
  };
}

async function keywordVideos(q: string, n: number, f: VideoFilter = {}): Promise<Ranked[]> {
  const rows = await db.$queryRaw<VideoRow[]>`
    SELECT v.id, v."youtubeId", v.title, v."thumbnailUrl", v."publishedAt", v."viewCount" AS views, v."durationSec", v."hasTranscript",
      c.title AS "channelTitle", c."youtubeId" AS "channelYt",
      ts_headline('english', left(v.description, 2000), websearch_to_tsquery('english', ${q}), ${HL}) AS hl,
      ts_rank_cd(v."searchVector", websearch_to_tsquery('english', ${q}))
        * (1 + 0.03 * ln(1 + coalesce(v."viewCount", 0)::float))
        * (1 + 0.3 * exp(-extract(epoch from (now() - v."publishedAt")) / (86400 * 365))) AS rank
    FROM "Video" v JOIN "Channel" c ON c.id = v."channelId"
    WHERE v."searchVector" @@ websearch_to_tsquery('english', ${q}) AND ${videoFilters(f)}
    ORDER BY rank DESC LIMIT ${n}`;
  return rows.map(videoHit);
}

async function keywordTopics(q: string, n: number): Promise<Ranked[]> {
  const rows = await db.$queryRaw<{ id: string; slug: string; label: string; videoCount: number; channelCount: number; rank: number }[]>`
    SELECT id, slug, label, "videoCount", "channelCount", ts_rank_cd("searchVector", websearch_to_tsquery('english', ${q})) * ln(2 + "videoCount") AS rank
    FROM "Topic" WHERE "searchVector" @@ websearch_to_tsquery('english', ${q}) AND "videoCount" >= 2
    ORDER BY rank DESC LIMIT ${n}`;
  return rows.map(topicHit);
}

function topicHit(r: { id: string; slug: string; label: string; videoCount: number; channelCount: number; rank: number }): Ranked {
  return { key: `topic:${r.id}`, hit: { type: "topic", id: r.id, nodeId: `topic:${r.slug}`, title: r.label, subtitle: `${r.videoCount} videos · ${r.channelCount} channels`, snippet: null, thumbnailUrl: null, url: null, score: r.rank, meta: { videoCount: r.videoCount, channelCount: r.channelCount } } };
}

async function keywordNiches(q: string, n: number): Promise<Ranked[]> {
  const rows = await db.$queryRaw<{ id: string; slug: string; name: string; depth: number; channelCount: number; rank: number }[]>`
    SELECT id, slug, name, depth, "channelCount", greatest(similarity(name, ${q}), word_similarity(${q}, name)) AS rank FROM "Niche"
    WHERE name % ${q} OR ${q} <% name OR to_tsvector('english', name || ' ' || description) @@ websearch_to_tsquery('english', ${q})
    ORDER BY rank DESC LIMIT ${n}`;
  return rows.map(nicheHit);
}

function nicheHit(r: { id: string; slug: string; name: string; depth: number; channelCount: number; rank: number }): Ranked {
  return { key: `niche:${r.id}`, hit: { type: "niche", id: r.id, nodeId: `${r.depth === 0 ? "niche" : "subniche"}:${r.slug}`, title: r.name, subtitle: `${r.depth === 0 ? "Niche" : "Subniche"} · ${r.channelCount} channels`, snippet: null, thumbnailUrl: null, url: null, score: r.rank, meta: { channelCount: r.channelCount } } };
}

type ChunkRow = { chunkId: string; videoId: string; youtubeId: string; title: string; thumbnailUrl: string | null; channelTitle: string; channelYt: string; startSec: number; endSec: number; text: string; rank: number };

function groupTranscriptHits(rows: ChunkRow[], perVideo = 3): Ranked[] {
  const by = new Map<string, ChunkRow[]>();
  for (const r of rows) {
    const list = by.get(r.videoId) ?? [];
    if (list.length < perVideo) list.push(r);
    by.set(r.videoId, list);
  }
  return [...by.values()].map((chunks) => {
    const top = chunks[0]!;
    return {
      key: `transcript:${top.videoId}`,
      hit: {
        type: "transcript",
        id: top.videoId,
        nodeId: `video:${top.youtubeId}`,
        title: top.title,
        subtitle: top.channelTitle,
        snippet: top.text,
        thumbnailUrl: top.thumbnailUrl,
        url: watchUrl(top.youtubeId, top.startSec),
        score: top.rank,
        meta: { channelNodeId: `channel:${top.channelYt}` },
        chunks: chunks.map((c) => ({ chunkId: c.chunkId, startSec: c.startSec, endSec: c.endSec, text: c.text, url: watchUrl(c.youtubeId, c.startSec) })),
      },
    };
  });
}

async function keywordTranscripts(q: string, n: number, f: VideoFilter = {}): Promise<Ranked[]> {
  const rows = await db.$queryRaw<ChunkRow[]>`
    SELECT tc.id AS "chunkId", v.id AS "videoId", v."youtubeId", v.title, v."thumbnailUrl", c.title AS "channelTitle", c."youtubeId" AS "channelYt",
      tc."startSec", tc."endSec",
      ts_headline('english', tc.text, websearch_to_tsquery('english', ${q}), ${HL}) AS text,
      ts_rank_cd(tc."searchVector", websearch_to_tsquery('english', ${q})) AS rank
    FROM "TranscriptChunk" tc JOIN "Transcript" t ON t.id = tc."transcriptId" JOIN "Video" v ON v.id = t."videoId" JOIN "Channel" c ON c.id = v."channelId"
    WHERE tc."searchVector" @@ websearch_to_tsquery('english', ${q}) AND ${videoFilters(f)}
    ORDER BY rank DESC LIMIT ${n * 3}`;
  return groupTranscriptHits(rows).slice(0, n);
}

// ── Semantic ───────────────────────────────────────────────────────────────

async function semanticChannels(vec: string, n: number): Promise<Ranked[]> {
  const rows = await db.$queryRaw<{ id: string; youtubeId: string; title: string; handle: string | null; thumbnailUrl: string | null; subs: bigint | null; rank: number }[]>`
    SELECT id, "youtubeId", title, handle, "thumbnailUrl", "subscriberCount" AS subs, 1 - (embedding <=> ${vec}::vector) AS rank
    FROM "Channel" WHERE embedding IS NOT NULL AND "isAvailable" ORDER BY embedding <=> ${vec}::vector LIMIT ${n}`;
  return rows.map((r) => ({ key: `channel:${r.id}`, hit: { type: "channel", id: r.id, nodeId: `channel:${r.youtubeId}`, title: r.title, subtitle: r.handle ? `@${r.handle}` : null, snippet: null, thumbnailUrl: r.thumbnailUrl, url: channelUrl(r.youtubeId), score: r.rank, meta: { subscriberCount: r.subs === null ? null : Number(r.subs), similarity: +r.rank.toFixed(3) } } }));
}

async function semanticVideos(vec: string, n: number, f: VideoFilter = {}): Promise<Ranked[]> {
  const rows = await db.$queryRaw<VideoRow[]>`
    SELECT v.id, v."youtubeId", v.title, v."thumbnailUrl", v."publishedAt", v."viewCount" AS views, v."durationSec", v."hasTranscript",
      c.title AS "channelTitle", c."youtubeId" AS "channelYt", 1 - (v.embedding <=> ${vec}::vector) AS rank
    FROM "Video" v JOIN "Channel" c ON c.id = v."channelId"
    WHERE v.embedding IS NOT NULL AND ${videoFilters(f)} ORDER BY v.embedding <=> ${vec}::vector LIMIT ${n}`;
  return rows.map(videoHit);
}

async function semanticTopics(vec: string, n: number): Promise<Ranked[]> {
  const rows = await db.$queryRaw<{ id: string; slug: string; label: string; videoCount: number; channelCount: number; rank: number }[]>`
    SELECT id, slug, label, "videoCount", "channelCount", 1 - (embedding <=> ${vec}::vector) AS rank FROM "Topic"
    WHERE embedding IS NOT NULL AND "videoCount" >= 2 ORDER BY embedding <=> ${vec}::vector LIMIT ${n}`;
  return rows.map(topicHit);
}

async function semanticNiches(vec: string, n: number): Promise<Ranked[]> {
  const rows = await db.$queryRaw<{ id: string; slug: string; name: string; depth: number; channelCount: number; rank: number }[]>`
    SELECT id, slug, name, depth, "channelCount", 1 - (centroid <=> ${vec}::vector) AS rank FROM "Niche"
    WHERE centroid IS NOT NULL ORDER BY centroid <=> ${vec}::vector LIMIT ${n}`;
  return rows.map(nicheHit);
}

async function semanticTranscripts(vec: string, n: number, f: VideoFilter = {}): Promise<Ranked[]> {
  const rows = await db.$queryRaw<ChunkRow[]>`
    SELECT x.*, meta.* FROM (
      SELECT tc.id AS "chunkId", t."videoId", tc."startSec", tc."endSec", tc.text, 1 - (tc.embedding <=> ${vec}::vector) AS rank
      FROM "TranscriptChunk" tc JOIN "Transcript" t ON t.id = tc."transcriptId"
      WHERE tc.embedding IS NOT NULL ORDER BY tc.embedding <=> ${vec}::vector LIMIT ${n * 6}
    ) x JOIN LATERAL (
      SELECT v."youtubeId", v.title, v."thumbnailUrl", c.title AS "channelTitle", c."youtubeId" AS "channelYt"
      FROM "Video" v JOIN "Channel" c ON c.id = v."channelId" WHERE v.id = x."videoId" AND ${videoFilters(f)}
    ) meta ON true ORDER BY x.rank DESC`;
  return groupTranscriptHits(rows.map((r) => ({ ...r, text: r.text.length > 320 ? `${r.text.slice(0, 320)}…` : r.text }))).slice(0, n);
}

// ── Orchestration ──────────────────────────────────────────────────────────

const KEYWORD: Record<SearchType, (q: string, n: number, f: VideoFilter) => Promise<Ranked[]>> = {
  channel: (q, n) => keywordChannels(q, n),
  video: keywordVideos,
  topic: (q, n) => keywordTopics(q, n),
  transcript: keywordTranscripts,
  niche: (q, n) => keywordNiches(q, n),
};
const SEMANTIC: Record<SearchType, (v: string, n: number, f: VideoFilter) => Promise<Ranked[]>> = {
  channel: (v, n) => semanticChannels(v, n),
  video: semanticVideos,
  topic: (v, n) => semanticTopics(v, n),
  transcript: semanticTranscripts,
  niche: (v, n) => semanticNiches(v, n),
};

export interface SearchParams {
  q: string;
  mode: SearchMode;
  types: SearchType[];
  limit: number;
  cursor?: string;
  filter?: VideoFilter;
}

export interface SearchResult {
  items: SearchHit[];
  nextCursor: string | null;
  mode: SearchMode;
  /** Mode actually used (semantic → keyword when embeddings are unavailable). */
  effectiveMode: SearchMode;
  counts: Partial<Record<SearchType, number>>;
}

export async function search(p: SearchParams): Promise<SearchResult> {
  const offset = decodeCursor<{ o: number }>(p.cursor)?.o ?? 0;
  const depth = Math.min(200, offset + p.limit + 1);
  const f = p.filter ?? {};
  let effective = p.mode;
  let vec: string | null = null;
  if (p.mode !== "keyword") {
    const v = await embedQuery(p.q);
    if (v) vec = toVectorLiteral(v);
    else effective = "keyword";
  }
  const lists: Ranked[][] = [];
  const counts: Partial<Record<SearchType, number>> = {};
  const byKey = new Map<string, SearchHit>();
  await Promise.all(
    p.types.map(async (t) => {
      const kw = effective !== "semantic" ? await KEYWORD[t](p.q, depth, f) : [];
      const floor = minSimilarity();
      const sem = vec && effective !== "keyword" ? (await SEMANTIC[t](vec, depth, f)).filter((r) => r.hit.score >= floor) : [];
      for (const r of [...sem, ...kw]) {
        // Prefer the keyword version (has highlights) but keep transcript chunks from both.
        const prev = byKey.get(r.key);
        byKey.set(r.key, prev && !r.hit.snippet ? prev : r.hit);
      }
      if (kw.length) lists.push(kw);
      if (sem.length) lists.push(sem);
      counts[t] = new Set([...kw, ...sem].map((r) => r.key)).size;
    }),
  );
  let fused: { id: string; score: number }[];
  if (effective === "hybrid") fused = rrf(lists.map((l) => l.map((r) => r.key)));
  else fused = lists.flat().sort((a, b) => b.hit.score - a.hit.score).map((r) => ({ id: r.key, score: r.hit.score }));
  const seen = new Set<string>();
  const ordered = fused.filter((x) => !seen.has(x.id) && seen.add(x.id));
  const page = ordered.slice(offset, offset + p.limit).map((x) => ({ ...byKey.get(x.id)!, score: +x.score.toFixed(5) }));
  return { items: page, nextCursor: ordered.length > offset + p.limit ? encodeCursor({ o: offset + p.limit }) : null, mode: p.mode, effectiveMode: effective, counts };
}

// ── Fuzzy autocomplete (pg_trgm) ───────────────────────────────────────────

export async function suggest(q: string, limit = 6): Promise<SuggestItem[]> {
  const s = q.trim().slice(0, 100);
  if (!s) return [];
  const like = `${s.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const [channels, topics, niches, videos] = await Promise.all([
    db.$queryRaw<{ id: string; youtubeId: string; title: string; handle: string | null; thumbnailUrl: string | null; s: number }[]>`
      SELECT id, "youtubeId", title, handle, "thumbnailUrl",
        greatest(word_similarity(${s}, title), coalesce(word_similarity(${s}, handle), 0)) + CASE WHEN title ILIKE ${like} OR handle ILIKE ${like} THEN 0.5 ELSE 0 END AS s
      FROM "Channel" WHERE (${s} <% title OR ${s} <% handle OR title ILIKE ${like} OR handle ILIKE ${like}) AND "isAvailable"
      ORDER BY s DESC, "subscriberCount" DESC NULLS LAST LIMIT ${limit}`,
    db.$queryRaw<{ id: string; slug: string; label: string; videoCount: number; s: number }[]>`
      SELECT id, slug, label, "videoCount", word_similarity(${s}, label) + CASE WHEN label ILIKE ${like} THEN 0.5 ELSE 0 END AS s
      FROM "Topic" WHERE (${s} <% label OR label ILIKE ${like}) AND "videoCount" >= 2
      ORDER BY s DESC, "videoCount" DESC LIMIT ${limit}`,
    db.$queryRaw<{ id: string; slug: string; name: string; depth: number; s: number }[]>`
      SELECT id, slug, name, depth, word_similarity(${s}, name) + CASE WHEN name ILIKE ${like} THEN 0.5 ELSE 0 END AS s
      FROM "Niche" WHERE ${s} <% name OR name ILIKE ${like} ORDER BY s DESC LIMIT ${limit}`,
    db.$queryRaw<{ id: string; youtubeId: string; title: string; thumbnailUrl: string | null; channelTitle: string; s: number }[]>`
      SELECT v.id, v."youtubeId", v.title, v."thumbnailUrl", c.title AS "channelTitle", word_similarity(${s}, v.title) AS s
      FROM "Video" v JOIN "Channel" c ON c.id = v."channelId" WHERE ${s} <% v.title AND v."isAvailable"
      ORDER BY s DESC, v."viewCount" DESC NULLS LAST LIMIT ${limit}`,
  ]);
  return [
    ...niches.map((n) => ({ type: "niche" as const, id: n.id, nodeId: `${n.depth === 0 ? "niche" : "subniche"}:${n.slug}`, label: n.name, sublabel: n.depth === 0 ? "Niche" : "Subniche", thumbnailUrl: null, score: n.s })),
    ...channels.map((c) => ({ type: "channel" as const, id: c.id, nodeId: `channel:${c.youtubeId}`, label: c.title, sublabel: c.handle ? `@${c.handle}` : null, thumbnailUrl: c.thumbnailUrl, score: c.s })),
    ...topics.map((t) => ({ type: "topic" as const, id: t.id, nodeId: `topic:${t.slug}`, label: t.label, sublabel: `${t.videoCount} videos`, thumbnailUrl: null, score: t.s })),
    ...videos.map((v) => ({ type: "video" as const, id: v.id, nodeId: `video:${v.youtubeId}`, label: v.title, sublabel: v.channelTitle, thumbnailUrl: v.thumbnailUrl, score: v.s })),
  ];
}

// ── Channel-scoped videos (list + search + facets) ─────────────────────────

export async function channelVideos(channelId: string, q: ChannelVideosQuery) {
  const f: VideoFilter = { channelId, publishedAfter: q.publishedAfter, publishedBefore: q.publishedBefore, duration: q.duration, minViews: q.minViews, maxViews: q.maxViews, hasTranscript: q.hasTranscript };
  const offset = decodeCursor<{ o: number }>(q.cursor)?.o ?? 0;
  const facets = await videoFacets(channelId);
  if (q.q?.trim()) {
    const r = await search({ q: q.q, mode: "hybrid", types: ["video"], limit: q.limit, cursor: q.cursor, filter: f });
    let items = r.items;
    if (q.sort === "recent") items = [...items].sort((a, b) => String(b.meta?.publishedAt).localeCompare(String(a.meta?.publishedAt)));
    if (q.sort === "views") items = [...items].sort((a, b) => Number(b.meta?.viewCount ?? 0) - Number(a.meta?.viewCount ?? 0));
    return { items, nextCursor: r.nextCursor, facets, effectiveMode: r.effectiveMode };
  }
  const order = q.sort === "views" ? Prisma.sql`v."viewCount" DESC NULLS LAST, v.id` : Prisma.sql`v."publishedAt" DESC, v.id`;
  const rows = await db.$queryRaw<VideoRow[]>`
    SELECT v.id, v."youtubeId", v.title, v."thumbnailUrl", v."publishedAt", v."viewCount" AS views, v."durationSec", v."hasTranscript",
      c.title AS "channelTitle", c."youtubeId" AS "channelYt", 0::float AS rank
    FROM "Video" v JOIN "Channel" c ON c.id = v."channelId" WHERE ${videoFilters(f)}
    ORDER BY ${order} OFFSET ${offset} LIMIT ${q.limit + 1}`;
  return {
    items: rows.slice(0, q.limit).map((r) => videoHit(r).hit),
    nextCursor: rows.length > q.limit ? encodeCursor({ o: offset + q.limit }) : null,
    facets,
    effectiveMode: "keyword" as SearchMode,
  };
}

async function videoFacets(channelId: string) {
  const [r] = await db.$queryRaw<{ total: number; shorts: number; lt10: number; mid: number; gt30: number; transcripts: number; minDate: Date | null; maxDate: Date | null; maxViews: bigint | null }[]>`
    SELECT count(*)::int total,
      count(*) FILTER (WHERE "isShort")::int shorts,
      count(*) FILTER (WHERE NOT "isShort" AND "durationSec" < 600)::int lt10,
      count(*) FILTER (WHERE "durationSec" BETWEEN 600 AND 1800)::int mid,
      count(*) FILTER (WHERE "durationSec" > 1800)::int gt30,
      count(*) FILTER (WHERE "hasTranscript")::int transcripts,
      min("publishedAt") "minDate", max("publishedAt") "maxDate", max("viewCount") "maxViews"
    FROM "Video" WHERE "channelId" = ${channelId} AND "isAvailable"`;
  return {
    total: r?.total ?? 0,
    duration: { short: r?.shorts ?? 0, lt10: r?.lt10 ?? 0, "10to30": r?.mid ?? 0, gt30: r?.gt30 ?? 0 },
    hasTranscript: r?.transcripts ?? 0,
    dateRange: { min: r?.minDate?.toISOString() ?? null, max: r?.maxDate?.toISOString() ?? null },
    maxViews: r?.maxViews === null || r?.maxViews === undefined ? 0 : Number(r.maxViews),
  };
}

/** In-transcript search for one video (video page). */
export async function searchInTranscript(videoId: string, q: string) {
  return db.$queryRaw<{ id: string; idx: number; startSec: number; endSec: number; text: string; rank: number }[]>`
    SELECT tc.id, tc.idx, tc."startSec", tc."endSec",
      ts_headline('english', tc.text, websearch_to_tsquery('english', ${q}), 'StartSel=<mark>, StopSel=</mark>, HighlightAll=true') AS text,
      ts_rank_cd(tc."searchVector", websearch_to_tsquery('english', ${q})) AS rank
    FROM "TranscriptChunk" tc JOIN "Transcript" t ON t.id = tc."transcriptId"
    WHERE t."videoId" = ${videoId} AND (tc."searchVector" @@ websearch_to_tsquery('english', ${q}) OR tc.text ILIKE ${`%${q.replace(/[%_\\]/g, "")}%`})
    ORDER BY tc.idx`;
}
