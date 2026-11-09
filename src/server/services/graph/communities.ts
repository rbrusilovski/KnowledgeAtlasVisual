import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import { db, Prisma } from "@/server/db";
import { redis, key } from "@/server/redis";
import { log } from "@/server/logger";
import { publish } from "@/server/services/realtime";

const KINDS = ["SIMILAR", "CO_TOPIC", "FEATURED", "CHANNEL_TOPIC", "TOPIC_RELATED", "CO_DISCOVERED"] as const;

/** Louvain over channel + topic nodes. Stable community IDs: relabel by size so the largest is 0. */
export async function computeCommunities(): Promise<{ communities: number; changed: number; modularity: number }> {
  const nodes = await db.graphNode.findMany({ where: { type: { in: ["CHANNEL", "TOPIC"] } }, select: { id: true, communityId: true } });
  const edges = await db.graphEdge.findMany({ where: { kind: { in: [...KINDS] } }, select: { sourceId: true, targetId: true, weight: true, kind: true } });
  const g = new Graph({ type: "undirected", multi: false });
  for (const n of nodes) g.addNode(n.id);
  for (const e of edges) {
    if (!g.hasNode(e.sourceId) || !g.hasNode(e.targetId) || e.sourceId === e.targetId) continue;
    const w = e.weight * (e.kind === "CHANNEL_TOPIC" ? 0.6 : e.kind === "CO_DISCOVERED" ? 0.3 : 1);
    if (g.hasEdge(e.sourceId, e.targetId)) g.updateEdgeAttribute(e.sourceId, e.targetId, "weight", (x: number | undefined) => (x ?? 0) + w);
    else g.addEdge(e.sourceId, e.targetId, { weight: w });
  }
  if (!g.size) return { communities: 0, changed: 0, modularity: 0 };
  const result = louvain.detailed(g, { getEdgeWeight: "weight", resolution: 1, rng: mulberry(42) });
  const sizes = new Map<number, number>();
  for (const c of Object.values(result.communities)) sizes.set(c, (sizes.get(c) ?? 0) + 1);
  const order = [...sizes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([c]) => c);
  const relabel = new Map(order.map((c, i) => [c, i]));
  const changes = nodes.map((n) => ({ id: n.id, c: g.degree(n.id) ? relabel.get(result.communities[n.id]!)! : null })).filter((x) => x.c !== null && x.c !== undefined);
  const diff = changes.filter((x) => nodes.find((n) => n.id === x.id)!.communityId !== x.c);
  if (diff.length) {
    const v = (await db.$queryRaw<{ v: bigint }[]>`SELECT nextval('graph_version_seq') AS v`)[0]!.v;
    for (let i = 0; i < diff.length; i += 500) {
      const batch = diff.slice(i, i + 500);
      const values = Prisma.join(batch.map((d) => Prisma.sql`(${d.id}, ${d.c}::int)`));
      await db.$executeRaw`UPDATE "GraphNode" g SET "communityId" = v.c, version = ${v}, "updatedAt" = now() FROM (VALUES ${values}) AS v(id, c) WHERE g.id = v.id`;
    }
    await redis.set(key("graph", "version"), v.toString());
    await publish({ type: "graph.delta", scope: "global", payload: { fromVersion: (v - 1n).toString(), toVersion: v.toString(), nodeIds: diff.slice(0, 500).map((d) => d.id), communities: true } });
  }
  log().info({ communities: order.length, changed: diff.length, modularity: result.modularity }, "communities computed");
  return { communities: order.length, changed: diff.length, modularity: +result.modularity.toFixed(4) };
}

function mulberry(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
