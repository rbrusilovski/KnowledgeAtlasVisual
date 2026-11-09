import { createHash } from "node:crypto";
import { db } from "@/server/db";
import { redis, key } from "@/server/redis";
import { log } from "@/server/logger";
import { enqueue } from "@/server/jobs";
import { setVector } from "@/server/db/vector";
import { getProvider } from "./providers";

export { getProvider, type EmbeddingProvider, HashProvider, LocalProvider } from "./providers";

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

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

export async function embedTexts(texts: string[]): Promise<number[][]> {
  return embedCached(texts);
}

// ── Entity embedding (worker) ──────────────────────────────────────────────

export type EmbedEntity = "channel" | "video" | "topic" | "chunk" | "niche";

export async function embedEntities(entity: EmbedEntity, ids: string[]): Promise<{ embedded: number; skipped: number }> {
  let embedded = 0;
  let skipped = 0;
  if (entity === "channel") {
    for (const id of ids) {
      const c = await db.channel.findUnique({ where: { id }, select: { id: true, title: true, handle: true, description: true, keywords: true, embeddingHash: true, youtubeId: true } });
      if (!c) continue;
      const recent = await db.video.findMany({ where: { channelId: id }, orderBy: { publishedAt: "desc" }, take: 20, select: { title: true } });
      const text = channelText(c, recent.map((r) => r.title));
      const h = sha(`${getProvider().name}|${text}`);
      if (c.embeddingHash === h) {
        skipped++;
        continue;
      }
      const [v] = await embedCached([text]);
      await setVector("Channel", id, v!, { embeddingHash: h });
      embedded++;
      await enqueue.classify(id);
    }
    if (embedded) await enqueue.graph(ids.length ? (await db.channel.findMany({ where: { id: { in: ids } }, select: { youtubeId: true } })).map((c) => `channel:${c.youtubeId}`) : []);
  } else if (entity === "video") {
    const rows = await db.video.findMany({ where: { id: { in: ids } }, select: { id: true, title: true, tags: true, description: true, embeddingHash: true } });
    const todo = rows.map((r) => ({ r, text: videoText(r) })).map((x) => ({ ...x, h: sha(`${getProvider().name}|${x.text}`) })).filter((x) => x.r.embeddingHash !== x.h);
    skipped = rows.length - todo.length;
    const vecs = await embedCached(todo.map((t) => t.text));
    for (let i = 0; i < todo.length; i++) await setVector("Video", todo[i]!.r.id, vecs[i]!, { embeddingHash: todo[i]!.h });
    embedded = todo.length;
  } else if (entity === "topic") {
    const rows = await db.topic.findMany({ where: { id: { in: ids } }, select: { id: true, label: true, aliases: true } });
    const vecs = await embedCached(rows.map(topicText));
    for (let i = 0; i < rows.length; i++) await setVector("Topic", rows[i]!.id, vecs[i]!);
    embedded = rows.length;
  } else if (entity === "chunk") {
    const rows = await db.transcriptChunk.findMany({ where: { id: { in: ids } }, select: { id: true, text: true } });
    const vecs = await embedCached(rows.map((r) => r.text));
    for (let i = 0; i < rows.length; i++) await setVector("TranscriptChunk", rows[i]!.id, vecs[i]!);
    embedded = rows.length;
  } else if (entity === "niche") {
    const rows = await db.niche.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, description: true, keywords: true } });
    const vecs = await embedCached(rows.map(nicheText));
    for (let i = 0; i < rows.length; i++) {
      await setVector("Niche", rows[i]!.id, vecs[i]!);
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
  return `${p.name} (${p.dimensions}d)`;
}

/** Re-embed everything (pnpm embeddings:reindex). */
export async function reindexAll(onProgress?: (entity: string, n: number) => void) {
  await db.$executeRaw`UPDATE "Channel" SET "embeddingHash" = NULL`;
  await db.$executeRaw`UPDATE "Video" SET "embeddingHash" = NULL`;
  for (const [entity, ids] of [
    ["niche", (await db.niche.findMany({ select: { id: true } })).map((r) => r.id)],
    ["topic", (await db.topic.findMany({ select: { id: true } })).map((r) => r.id)],
    ["video", (await db.video.findMany({ select: { id: true } })).map((r) => r.id)],
    ["chunk", (await db.transcriptChunk.findMany({ select: { id: true } })).map((r) => r.id)],
    ["channel", (await db.channel.findMany({ select: { id: true } })).map((r) => r.id)],
  ] as const) {
    for (let i = 0; i < ids.length; i += 200) {
      await embedEntities(entity, ids.slice(i, i + 200));
      onProgress?.(entity, Math.min(ids.length, i + 200));
    }
  }
}
