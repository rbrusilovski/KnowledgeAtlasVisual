import { createHash } from "node:crypto";
import { db } from "@/server/db";
import { redis, key } from "@/server/redis";
import { log } from "@/server/logger";
import { enqueue } from "@/server/jobs";
import { setVector, VECTOR_TABLES, vectorColumn, type VectorTable } from "@/server/db/vector";
import { getProvider } from "./providers";
import { allowed as policyAllows } from "@/server/youtube/policy";

export { getProvider, type EmbeddingProvider, HashProvider, LocalProvider } from "./providers";

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

// ── Vector space tracking (D4) ─────────────────────────────────────────────

/** Identifies the vector space a stored embedding belongs to: provider/model + dimension. */
export function embeddingModelId(): string {
  const p = getProvider();
  return `${p.name}@${p.dimensions}`;
}

export interface EmbeddingSpace {
  model: string;
  dimensions: number;
  /** Declared dimension of each vector column (from the database). */
  columns: Record<VectorTable, number | null>;
  /** Stored vectors produced by a different model, per table. */
  stale: Record<VectorTable, number>;
  /** Rows that should have a vector but don't yet. */
  missing: Record<VectorTable, number>;
  /** Semantic features are disabled while vectors from different models (or dimensions) would be compared. */
  blocked: boolean;
  reason: string | null;
}

let spaceCache: { at: number; space: EmbeddingSpace } | null = null;
export function invalidateEmbeddingSpace() {
  spaceCache = null;
}

/**
 * Column dimensions + stale/missing vectors. Cached in-process: 60 s when consistent, only 5 s when blocked, so a
 * reindex finishing in another process (the CLI) is noticed quickly.
 */
export async function embeddingSpace(opts: { fresh?: boolean } = {}): Promise<EmbeddingSpace> {
  if (!opts.fresh && spaceCache && Date.now() - spaceCache.at < (spaceCache.space.blocked ? 5_000 : 60_000)) return spaceCache.space;
  const model = embeddingModelId();
  const columns = {} as EmbeddingSpace["columns"];
  const stale = {} as EmbeddingSpace["stale"];
  const missing = {} as EmbeddingSpace["missing"];
  for (const t of VECTOR_TABLES) {
    const col = vectorColumn(t);
    const [d] = await db.$queryRawUnsafe<{ t: string | null }[]>(`SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = '"${t}"'::regclass AND attname = $1`, col);
    columns[t] = d?.t ? Number(/vector\((\d+)\)/.exec(d.t)?.[1] ?? NaN) || null : null;
    const [c] = await db.$queryRawUnsafe<{ stale: number; missing: number }[]>(
      `SELECT count(*) FILTER (WHERE "${col}" IS NOT NULL AND "embeddingModel" IS NOT NULL AND "embeddingModel" <> $1)::int AS stale,
              count(*) FILTER (WHERE "${col}" IS NULL)::int AS missing FROM "${t}"`,
      model,
    );
    stale[t] = c?.stale ?? 0;
    missing[t] = c?.missing ?? 0;
  }
  const dims = getProvider().dimensions;
  const badDim = VECTOR_TABLES.filter((t) => columns[t] !== null && columns[t] !== dims);
  const staleTotal = Object.values(stale).reduce((a, b) => a + b, 0);
  const reason = badDim.length
    ? `vector columns are ${columns[badDim[0]!]}-d but the provider produces ${dims}-d (${badDim.join(", ")}) — needs a migration + pnpm embeddings:reindex`
    : staleTotal
      ? `${staleTotal} stored vectors come from another model than ${model} — run pnpm embeddings:reindex`
      : null;
  const space: EmbeddingSpace = { model, dimensions: dims, columns, stale, missing, blocked: Boolean(reason), reason };
  spaceCache = { at: Date.now(), space };
  return space;
}

/** False while stored vectors are from another model/dimension: callers must not compare vectors. */
export async function semanticAvailable(): Promise<boolean> {
  return !(await embeddingSpace()).blocked;
}

/**
 * One-time upgrade step: vectors stored before model tracking existed (embeddingModel NULL) are attributed to the
 * currently configured model. Run by the worker at boot and by the reindex script.
 */
export async function adoptLegacyVectors(): Promise<number> {
  const model = embeddingModelId();
  let n = 0;
  for (const t of VECTOR_TABLES) n += await db.$executeRawUnsafe(`UPDATE "${t}" SET "embeddingModel" = $1 WHERE "${vectorColumn(t)}" IS NOT NULL AND "embeddingModel" IS NULL`, model);
  if (n) log().info({ rows: n, model }, "attributed legacy vectors to the configured embedding model");
  invalidateEmbeddingSpace();
  return n;
}

// ── Text recipes (spec §7.4) ───────────────────────────────────────────────

export function channelText(c: { title: string; handle: string | null; description: string; keywords: string[] }, recentTitles: string[]) {
  return [c.title, c.handle ? `@${c.handle}` : "", c.description.slice(0, 1500), c.keywords.join(", "), recentTitles.slice(0, 20).join(". ")].filter(Boolean).join("\n");
}
export function videoText(v: { title: string; tags: string[]; description: string }) {
  return [v.title, v.tags.join(", "), v.description.slice(0, 1000)].filter(Boolean).join("\n");
}
export function topicText(t: { label: string; aliases: string[] }) {
  return [t.label, ...t.aliases.filter((a) => a !== t.label)].join(", ");
}
export function nicheText(n: { name: string; description: string; keywords: string[] }) {
  return `${n.name}. ${n.description} ${n.keywords.join(", ")}`;
}

// ── Embedding cache by content hash (Redis) ────────────────────────────────

async function embedCached(texts: string[]): Promise<number[][]> {
  const p = getProvider();
  const keys = texts.map((t) => key("emb", p.name, sha(t)));
  const cached = keys.length ? await redis.mgetBuffer(...keys) : [];
  const missingIdx: number[] = [];
  // Copy into a fresh, 4-byte-aligned buffer: Redis Buffers can sit at any byteOffset in Node's pool.
  const out: (number[] | null)[] = cached.map((b) => (b && b.byteLength % 4 === 0 ? Array.from(new Float32Array(Uint8Array.from(b).buffer)) : null));
  out.forEach((v, i) => !v && missingIdx.push(i));
  if (missingIdx.length) {
    const fresh = await p.embed(missingIdx.map((i) => texts[i]!));
    const pipe = redis.pipeline();
    missingIdx.forEach((i, j) => {
      out[i] = fresh[j]!;
      pipe.set(keys[i]!, Buffer.from(new Float32Array(fresh[j]!).buffer), "EX", 30 * 86400);
    });
    await pipe.exec();
  }
  return out as number[][];
}

/** Embeds ad-hoc texts for comparison with stored vectors; returns [] while the vector space is mixed (D4). */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!(await semanticAvailable())) return [];
  return embedCached(texts);
}

// ── Entity embedding (worker) ──────────────────────────────────────────────

export type EmbedEntity = "channel" | "video" | "topic" | "chunk" | "niche";

export async function embedEntities(entity: EmbedEntity, ids: string[], opts: { reindex?: boolean } = {}): Promise<{ embedded: number; skipped: number }> {
  let embedded = 0;
  let skipped = 0;
  const model = embeddingModelId();
  // While a reindex is pending, regular jobs don't add vectors; the skipped rows keep embedding = NULL and are picked up
  // by the reindex (it also processes rows without a vector).
  if (!opts.reindex) {
    let space = await embeddingSpace();
    if (space.blocked) space = await embeddingSpace({ fresh: true }); // never skip on a stale cached verdict
    if (space.blocked) {
      log().warn({ entity, n: ids.length, reason: space.reason }, "embedding skipped: vector space needs reindex");
      return { embedded: 0, skipped: ids.length };
    }
  }
  // Embeddings of API Data are derived data (policy-gated for live data). Niche centroids come from Atlas's own taxonomy.
  if (entity !== "niche" && !policyAllows("derived-data")) return { embedded: 0, skipped: ids.length };
  if (entity === "channel") {
    for (const id of ids) {
      const c = await db.channel.findUnique({ where: { id }, select: { id: true, title: true, handle: true, description: true, keywords: true, embeddingHash: true, youtubeId: true } });
      if (!c) continue;
      const recent = await db.video.findMany({ where: { channelId: id }, orderBy: { publishedAt: "desc" }, take: 20, select: { title: true } });
      const text = channelText(c, recent.map((r) => r.title));
      const h = sha(`${getProvider().name}|${text}`);
      if (c.embeddingHash === h && !opts.reindex) {
        skipped++;
        continue;
      }
      const [v] = await embedCached([text]);
      await setVector("Channel", id, v!, { model, embeddingHash: h });
      embedded++;
      await enqueue.classify(id);
    }
    if (embedded) await enqueue.graph(ids.length ? (await db.channel.findMany({ where: { id: { in: ids } }, select: { youtubeId: true } })).map((c) => `channel:${c.youtubeId}`) : []);
  } else if (entity === "video") {
    const rows = await db.video.findMany({ where: { id: { in: ids } }, select: { id: true, title: true, tags: true, description: true, embeddingHash: true } });
    const todo = rows.map((r) => ({ r, text: videoText(r) })).map((x) => ({ ...x, h: sha(`${getProvider().name}|${x.text}`) })).filter((x) => opts.reindex || x.r.embeddingHash !== x.h);
    skipped = rows.length - todo.length;
    const vecs = await embedCached(todo.map((t) => t.text));
    for (let i = 0; i < todo.length; i++) await setVector("Video", todo[i]!.r.id, vecs[i]!, { model, embeddingHash: todo[i]!.h });
    embedded = todo.length;
  } else if (entity === "topic") {
    const rows = await db.topic.findMany({ where: { id: { in: ids } }, select: { id: true, label: true, aliases: true } });
    const vecs = await embedCached(rows.map(topicText));
    for (let i = 0; i < rows.length; i++) await setVector("Topic", rows[i]!.id, vecs[i]!, { model });
    embedded = rows.length;
  } else if (entity === "chunk") {
    const rows = await db.transcriptChunk.findMany({ where: { id: { in: ids } }, select: { id: true, text: true } });
    const vecs = await embedCached(rows.map((r) => r.text));
    for (let i = 0; i < rows.length; i++) await setVector("TranscriptChunk", rows[i]!.id, vecs[i]!, { model });
    embedded = rows.length;
  } else if (entity === "niche") {
    const rows = await db.niche.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, description: true, keywords: true } });
    const vecs = await embedCached(rows.map(nicheText));
    for (let i = 0; i < rows.length; i++) {
      await setVector("Niche", rows[i]!.id, vecs[i]!, { model });
      await db.niche.update({ where: { id: rows[i]!.id }, data: { centroidCount: 0 } });
    }
    embedded = rows.length;
  }
  return { embedded, skipped };
}

// ── Query embedding (web process) ──────────────────────────────────────────

/**
 * Embeds a search query in-process (lazy model load). Returns null on timeout/failure so callers
 * degrade to keyword search. Decision: in-process rather than worker RPC (see DECISIONS.md).
 */
export async function embedQuery(q: string, timeoutMs = 2_000): Promise<number[] | null> {
  try {
    if (!(await semanticAvailable())) return null;
    const result = await Promise.race([embedCached([q.slice(0, 500)]), new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);
    return result ? result[0]! : null;
  } catch (err) {
    log().warn({ err }, "query embedding failed; falling back to keyword search");
    return null;
  }
}

/** Kick off model load without waiting (called from instrumentation + worker boot). */
export function warmup() {
  void getProvider()
    .embed(["warmup"])
    .then(() => redis.set(key("embeddings", "ready"), getProvider().name, "EX", 3600))
    .catch((err) => log().warn({ err }, "embedding warmup failed"));
}

export async function embeddingStatus(): Promise<string> {
  const p = getProvider();
  await Promise.race([p.embed(["health"]), new Promise((_, rej) => setTimeout(() => rej(new Error("model loading")), 3_000))]);
  const space = await embeddingSpace();
  if (space.blocked) throw new Error(space.reason!);
  return `${p.name} (${p.dimensions}d)`;
}

const ENTITY_TABLE: [EmbedEntity, VectorTable][] = [
  ["niche", "Niche"],
  ["topic", "Topic"],
  ["video", "Video"],
  ["chunk", "TranscriptChunk"],
  ["channel", "Channel"],
];

export interface ReindexOptions {
  /** Re-embed every row, not only rows from another model / without a vector. */
  all?: boolean;
  batch?: number;
  onProgress?: (entity: string, done: number, remaining: number) => void;
}

/**
 * pnpm embeddings:reindex (D4). Refuses when a vector column's dimension differs from the provider (needs a schema
 * migration first). Re-embeds only rows whose `embeddingModel` differs from the current model or that have no vector,
 * in batches — progress lives in the rows themselves, so an interrupted run resumes where it stopped. Semantic
 * features stay disabled until no stale vectors remain.
 */
export async function reindexEmbeddings(opts: ReindexOptions = {}) {
  const space = await embeddingSpace({ fresh: true });
  const badDim = VECTOR_TABLES.filter((t) => space.columns[t] !== null && space.columns[t] !== space.dimensions);
  if (badDim.length) throw new Error(`Refusing to reindex: ${space.reason}`);
  await adoptLegacyVectors();
  const model = space.model;
  const batch = opts.batch ?? 200;
  const startedAt = new Date();
  const totals: Record<string, number> = {};
  for (const [entity, table] of ENTITY_TABLE) {
    const col = vectorColumn(table);
    // Keyset over ids: each row is visited once per run; an interrupted run simply starts again and skips rows that
    // already carry the current model.
    let after = "";
    let done = 0;
    for (;;) {
      const rows = opts.all
        ? await db.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "${table}" WHERE id > $1 ORDER BY id LIMIT $2`, after, batch)
        : await db.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "${table}" WHERE ("${col}" IS NULL OR "embeddingModel" IS DISTINCT FROM $1) AND id > $2 ORDER BY id LIMIT $3`, model, after, batch);
      if (!rows.length) break;
      await embedEntities(entity, rows.map((r) => r.id), { reindex: true });
      after = rows[rows.length - 1]!.id;
      done += rows.length;
      opts.onProgress?.(entity, done, -1);
    }
    totals[entity] = done;
  }
  invalidateEmbeddingSpace();
  const after = await embeddingSpace({ fresh: true });
  await redis.set(key("embeddings", "last-reindex"), JSON.stringify({ at: new Date().toISOString(), startedAt: startedAt.toISOString(), model, totals, blocked: after.blocked }));
  return { model, totals, space: after };
}

/** @deprecated use reindexEmbeddings({ all: true }) */
export async function reindexAll(onProgress?: (entity: string, n: number) => void) {
  return reindexEmbeddings({ all: true, onProgress: (e, d) => onProgress?.(e, d) });
}
