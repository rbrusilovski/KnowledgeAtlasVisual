/**
 * Graph consistency verification + repair (D5): compares the materialized GraphNode/GraphEdge tables with the
 * canonical rows they are derived from. `pnpm graph:verify [--repair]`.
 */
import { db } from "@/server/db";
import { redis, key } from "@/server/redis";
import { allNodeIds, buildDirty, deleteEdges, nextVersion, UNDIRECTED } from "./builder";

export interface GraphVerifyReport {
  expectedNodes: number;
  actualNodes: number;
  edges: number;
  missingNodes: string[];
  orphanNodes: string[];
  danglingEdges: string[];
  nonCanonicalEdges: string[];
  malformedEdgeIds: string[];
  dirty: { pending: number; oldestAgeSec: number | null };
  version: { redis: string | null; database: string | null };
  ok: boolean;
  repaired?: { rebuilt: number; edgesDeleted: number };
}

const SAMPLE = 50;

export async function verifyGraph(opts: { repair?: boolean } = {}): Promise<GraphVerifyReport> {
  const expected = await allNodeIds();
  const expectedSet = new Set(expected);
  const actual = (await db.graphNode.findMany({ select: { id: true } })).map((n) => n.id);
  const actualSet = new Set(actual);
  const missingNodes = expected.filter((id) => !actualSet.has(id));
  const orphanNodes = actual.filter((id) => !expectedSet.has(id));
  const dangling = await db.$queryRaw<{ id: string }[]>`
    SELECT e.id FROM "GraphEdge" e
    LEFT JOIN "GraphNode" s ON s.id = e."sourceId" LEFT JOIN "GraphNode" t ON t.id = e."targetId"
    WHERE s.id IS NULL OR t.id IS NULL`;
  const undirected = [...UNDIRECTED] as string[];
  const nonCanonical = await db.$queryRaw<{ id: string }[]>`SELECT id FROM "GraphEdge" WHERE kind::text = ANY(${undirected}) AND "sourceId" > "targetId"`;
  const malformed = await db.$queryRaw<{ id: string }[]>`SELECT id FROM "GraphEdge" WHERE id <> (kind::text || '|' || "sourceId" || '|' || "targetId")`;
  const [{ n: edges } = { n: 0 }] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "GraphEdge"`;
  const [{ v: dbVersion } = { v: null }] = await db.$queryRaw<{ v: bigint | null }[]>`SELECT max(version) AS v FROM "GraphNode"`;
  const pending = await redis.scard(key("graph", "dirty"));
  const since = await redis.get(key("graph", "dirty-since"));
  const report: GraphVerifyReport = {
    expectedNodes: expected.length,
    actualNodes: actual.length,
    edges,
    missingNodes: missingNodes.slice(0, SAMPLE),
    orphanNodes: orphanNodes.slice(0, SAMPLE),
    danglingEdges: dangling.map((d) => d.id).slice(0, SAMPLE),
    nonCanonicalEdges: nonCanonical.map((d) => d.id).slice(0, SAMPLE),
    malformedEdgeIds: malformed.map((d) => d.id).slice(0, SAMPLE),
    dirty: { pending, oldestAgeSec: since ? Math.round((Date.now() - Number(since)) / 1000) : null },
    version: { redis: await redis.get(key("graph", "version")), database: dbVersion === null ? null : dbVersion.toString() },
    ok: !missingNodes.length && !orphanNodes.length && !dangling.length && !nonCanonical.length && !malformed.length,
  };
  if (opts.repair && !report.ok) {
    // Rebuilding a node recomputes it and every edge it owns; missing source rows → node + edges removed (tombstoned).
    const rebuild = [...new Set([...missingNodes, ...orphanNodes])];
    let rebuilt = 0;
    for (let i = 0; i < rebuild.length; i += 250) rebuilt += (await buildDirty(rebuild.slice(i, i + 250))).dirty;
    const stillBad = await db.$queryRaw<{ id: string }[]>`
      SELECT e.id FROM "GraphEdge" e LEFT JOIN "GraphNode" s ON s.id = e."sourceId" LEFT JOIN "GraphNode" t ON t.id = e."targetId"
      WHERE s.id IS NULL OR t.id IS NULL OR (e.kind::text = ANY(${undirected}) AND e."sourceId" > e."targetId")
         OR e.id <> (e.kind::text || '|' || e."sourceId" || '|' || e."targetId")`;
    const edgesDeleted = stillBad.length ? await deleteEdges(stillBad.map((r) => r.id), await nextVersion()) : 0;
    report.repaired = { rebuilt, edgesDeleted };
  }
  return report;
}
