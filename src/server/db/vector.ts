import { db, Prisma } from "@/server/db";

/** number[] → pgvector literal '[0.1,0.2,…]'. Rejects NaN/Infinity. */
export function toVectorLiteral(v: number[]): string {
  for (const x of v) if (!Number.isFinite(x)) throw new Error("vector contains non-finite value");
  return `[${v.map((x) => +x.toFixed(7)).join(",")}]`;
}

export function parseVector(s: string | null): number[] | null {
  if (!s) return null;
  return s.slice(1, -1).split(",").map(Number);
}

export type VectorTable = "Channel" | "Video" | "Topic" | "TranscriptChunk" | "Niche";
const COLUMN: Record<VectorTable, string> = { Channel: "embedding", Video: "embedding", Topic: "embedding", TranscriptChunk: "embedding", Niche: "centroid" };

export async function setVector(table: VectorTable, id: string, v: number[], extra?: { embeddingHash?: string }) {
  const col = COLUMN[table];
  const lit = toVectorLiteral(v);
  if (extra?.embeddingHash !== undefined && (table === "Channel" || table === "Video")) {
    await db.$executeRawUnsafe(`UPDATE "${table}" SET "${col}" = $1::vector, "embeddingHash" = $2 WHERE id = $3`, lit, extra.embeddingHash, id);
  } else {
    await db.$executeRawUnsafe(`UPDATE "${table}" SET "${col}" = $1::vector WHERE id = $2`, lit, id);
  }
}

export async function getVector(table: VectorTable, id: string): Promise<number[] | null> {
  const col = COLUMN[table];
  const rows = await db.$queryRawUnsafe<{ v: string | null }[]>(`SELECT "${col}"::text AS v FROM "${table}" WHERE id = $1`, id);
  return parseVector(rows[0]?.v ?? null);
}

export interface KnnHit {
  id: string;
  similarity: number;
}

/**
 * Cosine KNN via HNSW. The `IS NOT NULL` predicate is REQUIRED: the HNSW indexes are partial.
 * `where` is an extra SQL fragment (Prisma.sql) appended with AND.
 */
export async function knn(table: VectorTable, v: number[], k: number, opts: { excludeId?: string; where?: Prisma.Sql; efSearch?: number } = {}): Promise<KnnHit[]> {
  const col = Prisma.raw(`"${COLUMN[table]}"`);
  const t = Prisma.raw(`"${table}"`);
  const lit = toVectorLiteral(v);
  const exclude = opts.excludeId ? Prisma.sql`AND id <> ${opts.excludeId}` : Prisma.empty;
  const extra = opts.where ? Prisma.sql`AND ${opts.where}` : Prisma.empty;
  const query = Prisma.sql`
    SELECT id, 1 - (${col} <=> ${lit}::vector) AS similarity
    FROM ${t}
    WHERE ${col} IS NOT NULL ${exclude} ${extra}
    ORDER BY ${col} <=> ${lit}::vector
    LIMIT ${k}`;
  if (opts.efSearch) {
    return db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL hnsw.ef_search = ${Math.min(1000, Math.max(10, opts.efSearch!))}`);
      return tx.$queryRaw<KnnHit[]>(query);
    });
  }
  return db.$queryRaw<KnnHit[]>(query);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}
