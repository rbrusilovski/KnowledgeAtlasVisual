import { db, type Prisma, type EdgeKind, type NodeType } from "@/server/db";
import { redis, key } from "@/server/redis";
import { cached } from "@/server/services/cache";
import { notFound } from "@/server/errors";
import { decodeCursor, encodeCursor } from "@/server/http/cursor";
import type { GraphQuery, GraphNodeDTO, GraphEdgeDTO, SubgraphDTO, DeltaDTO, EdgeKindT, NodeTypeT } from "@/shared/contracts/graph";

const ALL_KINDS: EdgeKind[] = ["CONTAINS", "IN_NICHE", "PUBLISHED", "MENTIONS", "CHANNEL_TOPIC", "FEATURED", "SIMILAR", "CO_TOPIC", "TOPIC_RELATED", "NICHE_TOPIC", "CO_DISCOVERED"];
/** Per-hop fan-out (top-k by weight per frontier node). */
const FANOUT = [40, 12, 6];
const EDGE_FACTOR = 8;

export async function currentVersion(): Promise<string> {
  const v = await redis.get(key("graph", "version"));
  if (v) return v;
  const [r] = await db.$queryRaw<{ v: bigint | null }[]>`SELECT GREATEST((SELECT max(version) FROM "GraphNode"), (SELECT max(version) FROM "GraphEdge"), (SELECT max(version) FROM "GraphTombstone")) AS v`;
  const s = (r?.v ?? 0n).toString();
  await redis.set(key("graph", "version"), s);
  return s;
}

type NodeRow = { id: string; type: NodeType; label: string; size: number; communityId: number | null; attrs: Prisma.JsonValue };
type EdgeRow = { id: string; sourceId: string; targetId: string; kind: EdgeKind; weight: number; evidence?: Prisma.JsonValue };

const nodeDTO = (n: NodeRow): GraphNodeDTO => ({ id: n.id, type: n.type as NodeTypeT, label: n.label, size: n.size, communityId: n.communityId, attrs: (n.attrs ?? {}) as Record<string, unknown> });
const edgeDTO = (e: EdgeRow, withEvidence = false): GraphEdgeDTO => ({
  id: e.id,
  source: e.sourceId,
  target: e.targetId,
  kind: e.kind as EdgeKindT,
  weight: e.weight,
  ...(withEvidence ? { evidence: (e.evidence ?? null) as Record<string, unknown> | null } : {}),
});
const nodeSelect = { id: true, type: true, label: true, size: true, communityId: true, attrs: true } as const;

/** Channel-level filters (subscriber range, upload recency, niches) as a predicate on node attrs. */
function channelPasses(n: NodeRow, q: GraphQuery, nicheSet: Set<string> | null): boolean {
  if (n.type !== "CHANNEL") return true;
  const a = (n.attrs ?? {}) as { subscriberCount?: number | null; latestVideoAt?: string | null; subniches?: string[]; niches?: string[] };
  if (q.minSubscribers !== undefined && (a.subscriberCount ?? 0) < q.minSubscribers) return false;
  if (q.maxSubscribers !== undefined && (a.subscriberCount ?? 0) > q.maxSubscribers) return false;
  if (q.publishedAfter && (!a.latestVideoAt || Date.parse(a.latestVideoAt) < q.publishedAfter.getTime())) return false;
  if (nicheSet && ![...(a.subniches ?? []), ...(a.niches ?? [])].some((s) => nicheSet.has(s))) return false;
  return true;
}

async function edgesAmong(ids: string[], kinds: EdgeKind[], minWeight: number, cap: number): Promise<EdgeRow[]> {
  if (ids.length < 2) return [];
  return db.$queryRaw<EdgeRow[]>`
    SELECT id, "sourceId", "targetId", kind, weight FROM "GraphEdge"
    WHERE "sourceId" = ANY(${ids}) AND "targetId" = ANY(${ids}) AND kind::text = ANY(${kinds as string[]}) AND weight >= ${minWeight}
    ORDER BY weight DESC LIMIT ${cap}`;
}

/** Default global view: niches + subniches + channels + top topics (no videos). */
async function globalView(q: GraphQuery): Promise<SubgraphDTO> {
  const types = (q.nodeTypes ?? ["NICHE", "SUBNICHE", "CHANNEL", "TOPIC"]) as NodeType[];
  const kinds = (q.edgeKinds ?? ALL_KINDS.filter((k) => k !== "PUBLISHED" && k !== "MENTIONS")) as EdgeKind[];
  const nicheSet = q.nicheIds?.length ? await expandNiches(q.nicheIds) : null;
  const structural = await db.graphNode.findMany({ where: { type: { in: types.filter((t) => t === "NICHE" || t === "SUBNICHE") } }, select: nodeSelect });
  const channels = types.includes("CHANNEL") ? await db.graphNode.findMany({ where: { type: "CHANNEL" }, select: nodeSelect, orderBy: { size: "desc" } }) : [];
  const videos = types.includes("VIDEO") ? await db.graphNode.findMany({ where: { type: "VIDEO" }, select: nodeSelect, orderBy: { size: "desc" }, take: q.limit }) : [];
  let topics: NodeRow[] = [];
  if (types.includes("TOPIC") && q.topics > 0) {
    topics = await db.$queryRaw<NodeRow[]>`
      SELECT id, type, label, size, "communityId", attrs FROM "GraphNode" WHERE type = 'TOPIC'
      ORDER BY (attrs->>'channelCount')::int DESC NULLS LAST, (attrs->>'videoCount')::int DESC NULLS LAST, id LIMIT ${q.topics}`;
  }
  let nodes = [...structural.filter((n) => !nicheSet || nicheSet.has(n.id.split(":")[1]!)), ...channels.filter((n) => channelPasses(n, q, nicheSet)), ...topics, ...videos];
  let truncated = false;
  if (nodes.length > q.limit) {
    truncated = true;
    const keepStructural = nodes.filter((n) => n.type === "NICHE" || n.type === "SUBNICHE");
    nodes = [...keepStructural, ...nodes.filter((n) => n.type !== "NICHE" && n.type !== "SUBNICHE").slice(0, Math.max(0, q.limit - keepStructural.length))];
  }
  let ids = nodes.map((n) => n.id);
  const edges = await edgesAmong(ids, kinds, q.minWeight, q.limit * EDGE_FACTOR);
  // When filtering by niche, drop topics that end up disconnected.
  if (nicheSet) {
    const touched = new Set(edges.flatMap((e) => [e.sourceId, e.targetId]));
    nodes = nodes.filter((n) => n.type !== "TOPIC" || touched.has(n.id));
    ids = nodes.map((n) => n.id);
  }
  const idSet = new Set(ids);
  return {
    version: await currentVersion(),
    nodes: nodes.map(nodeDTO),
    edges: edges.filter((e) => idSet.has(e.sourceId) && idSet.has(e.targetId)).map((e) => edgeDTO(e)),
    truncated: truncated || edges.length >= q.limit * EDGE_FACTOR,
  };
}

async function expandNiches(idsOrSlugs: string[]): Promise<Set<string>> {
  const rows = await db.niche.findMany({ where: { OR: [{ id: { in: idsOrSlugs } }, { slug: { in: idsOrSlugs.map((s) => s.replace(/^(sub)?niche:/, "")) } }] }, select: { slug: true, children: { select: { slug: true } }, parent: { select: { slug: true } } } });
  const out = new Set<string>();
  for (const r of rows) {
    out.add(r.slug);
    r.children.forEach((c) => out.add(c.slug));
    if (r.parent) out.add(r.parent.slug);
  }
  return out;
}

/** Bounded BFS: iterative SQL per hop, per-node fan-out top-k by weight, global node limit. */
async function localView(q: GraphQuery): Promise<SubgraphDTO> {
  if (!q.focus) throw new (await import("@/server/errors")).AppError("VALIDATION_ERROR", "focus is required for mode=local");
  const focus = await db.graphNode.findUnique({ where: { id: q.focus }, select: nodeSelect });
  if (!focus) throw notFound("Node");
  const kinds = (q.edgeKinds ?? ALL_KINDS) as EdgeKind[];
  const types = new Set((q.nodeTypes ?? ["NICHE", "SUBNICHE", "CHANNEL", "VIDEO", "TOPIC"]) as NodeType[]);
  const nicheSet = q.nicheIds?.length ? await expandNiches(q.nicheIds) : null;
  const visited = new Map<string, NodeRow>([[focus.id, focus]]);
  const edges = new Map<string, EdgeRow>();
  let frontier = [focus.id];
  let truncated = false;
  for (let hop = 0; hop < q.depth && frontier.length; hop++) {
    const k = FANOUT[hop] ?? 5;
    const rows = await db.$queryRaw<(EdgeRow & { other: string })[]>`
      SELECT id, "sourceId", "targetId", kind, weight, other FROM (
        SELECT e.id, e."sourceId", e."targetId", e.kind, e.weight,
               CASE WHEN e."sourceId" = ANY(${frontier}) THEN e."targetId" ELSE e."sourceId" END AS other,
               row_number() OVER (PARTITION BY CASE WHEN e."sourceId" = ANY(${frontier}) THEN e."sourceId" ELSE e."targetId" END ORDER BY e.weight DESC, e.id) AS rn
        FROM "GraphEdge" e
        WHERE (e."sourceId" = ANY(${frontier}) OR e."targetId" = ANY(${frontier}))
          AND e.kind::text = ANY(${kinds as string[]}) AND e.weight >= ${q.minWeight}
      ) x WHERE rn <= ${k}`;
    const newIds = [...new Set(rows.map((r) => r.other))].filter((id) => !visited.has(id));
    const newNodes = newIds.length ? await db.graphNode.findMany({ where: { id: { in: newIds } }, select: nodeSelect }) : [];
    const next: string[] = [];
    for (const n of newNodes) {
      if (!types.has(n.type) || !channelPasses(n, q, nicheSet)) continue;
      if (visited.size >= q.limit) {
        truncated = true;
        break;
      }
      visited.set(n.id, n);
      // Don't expand through structural hubs or videos (keeps neighborhoods meaningful).
      if (n.type !== "NICHE" && n.type !== "VIDEO") next.push(n.id);
    }
    for (const r of rows) if (visited.has(r.sourceId) && visited.has(r.targetId)) edges.set(r.id, r);
    frontier = next;
  }
  // Add edges among the visited set (e.g. between two neighbors) up to the cap.
  const among = await edgesAmong([...visited.keys()], kinds, q.minWeight, q.limit * EDGE_FACTOR);
  for (const e of among) edges.set(e.id, e);
  return { version: await currentVersion(), nodes: [...visited.values()].map(nodeDTO), edges: [...edges.values()].map((e) => edgeDTO(e)), truncated, focus: focus.id };
}

/** Subgraph with Redis caching keyed by params hash + current graph version. */
export async function getSubgraph(q: GraphQuery): Promise<SubgraphDTO> {
  const version = await currentVersion();
  return cached("graph:subgraph", { q, version }, { ttlSec: 600 }, () => (q.mode === "local" ? localView(q) : globalView(q)));
}

export async function getNeighbors(nodeId: string, opts: { edgeKinds?: string[]; limit: number; cursor?: string }) {
  const node = await db.graphNode.findUnique({ where: { id: nodeId }, select: nodeSelect });
  if (!node) throw notFound("Node");
  const offset = decodeCursor<{ o: number }>(opts.cursor)?.o ?? 0;
  const kinds = (opts.edgeKinds ?? ALL_KINDS) as string[];
  const rows = await db.$queryRaw<EdgeRow[]>`
    SELECT id, "sourceId", "targetId", kind, weight, evidence FROM "GraphEdge"
    WHERE ("sourceId" = ${nodeId} OR "targetId" = ${nodeId}) AND kind::text = ANY(${kinds})
    ORDER BY weight DESC, id OFFSET ${offset} LIMIT ${opts.limit + 1}`;
  const page = rows.slice(0, opts.limit);
  const otherIds = [...new Set(page.map((e) => (e.sourceId === nodeId ? e.targetId : e.sourceId)))];
  const nodes = await db.graphNode.findMany({ where: { id: { in: otherIds } }, select: nodeSelect });
  return {
    node: nodeDTO(node),
    nodes: nodes.map(nodeDTO),
    edges: page.map((e) => edgeDTO(e, true)),
    nextCursor: rows.length > opts.limit ? encodeCursor({ o: offset + opts.limit }) : null,
  };
}

const DELTA_MAX = 20_000;

export async function getDelta(since: bigint): Promise<DeltaDTO> {
  const toVersion = await currentVersion();
  const [oldest] = await db.$queryRaw<{ v: bigint | null }[]>`SELECT min(version) AS v FROM "GraphTombstone"`;
  const nodes = await db.graphNode.findMany({ where: { version: { gt: since } }, select: nodeSelect, take: DELTA_MAX + 1 });
  const edges = await db.graphEdge.findMany({ where: { version: { gt: since } }, select: { id: true, sourceId: true, targetId: true, kind: true, weight: true }, take: DELTA_MAX + 1 });
  const tomb = await db.graphTombstone.findMany({ where: { version: { gt: since } }, select: { kind: true, refId: true }, take: DELTA_MAX + 1 });
  // Tombstones older than retention may be gone: if the client is older than the oldest tombstone (and anything
  // was pruned), ask it to reset.
  const reset = nodes.length > DELTA_MAX || edges.length > DELTA_MAX || tomb.length > DELTA_MAX || (since > 0n && oldest?.v !== null && oldest?.v !== undefined && since < oldest.v - 1n && (await prunedSince(since)));
  const removedNodeIds = tomb.filter((t) => t.kind === "node").map((t) => t.refId);
  const removedEdgeIds = tomb.filter((t) => t.kind === "edge").map((t) => t.refId);
  const live = new Set(edges.map((e) => e.id));
  return {
    fromVersion: since.toString(),
    toVersion,
    nodes: nodes.map(nodeDTO),
    edges: edges.map((e) => edgeDTO(e)),
    removedNodeIds: removedNodeIds.filter((id) => !nodes.some((n) => n.id === id)),
    removedEdgeIds: removedEdgeIds.filter((id) => !live.has(id)),
    reset: Boolean(reset),
  };
}

async function prunedSince(since: bigint): Promise<boolean> {
  const marker = await redis.get(key("graph", "tombstones-pruned-before"));
  return marker !== null && BigInt(marker) > since;
}

/** "How are these two connected?" — bounded bidirectional BFS over all edges (undirected). */
export async function findPath(from: string, to: string, maxDepth = 4): Promise<{ nodes: GraphNodeDTO[]; edges: GraphEdgeDTO[] } | null> {
  if (from === to) {
    const n = await db.graphNode.findUnique({ where: { id: from }, select: nodeSelect });
    return n ? { nodes: [nodeDTO(n)], edges: [] } : null;
  }
  const prevA = new Map<string, { via: string; edge: EdgeRow } | null>([[from, null]]);
  const prevB = new Map<string, { via: string; edge: EdgeRow } | null>([[to, null]]);
  let fa = [from];
  let fb = [to];
  const expand = async (frontier: string[], prev: typeof prevA) => {
    const rows = await db.$queryRaw<EdgeRow[]>`
      SELECT id, "sourceId", "targetId", kind, weight FROM (
        SELECT e.*, row_number() OVER (PARTITION BY CASE WHEN e."sourceId" = ANY(${frontier}) THEN e."sourceId" ELSE e."targetId" END ORDER BY e.weight DESC) rn
        FROM "GraphEdge" e WHERE (e."sourceId" = ANY(${frontier}) OR e."targetId" = ANY(${frontier})) AND e.kind <> 'PUBLISHED'
      ) x WHERE rn <= 60`;
    const next: string[] = [];
    for (const r of rows) {
      const a = frontier.includes(r.sourceId) ? r.sourceId : r.targetId;
      const b = a === r.sourceId ? r.targetId : r.sourceId;
      if (!prev.has(b)) {
        prev.set(b, { via: a, edge: r });
        next.push(b);
      }
    }
    return next;
  };
  for (let d = 0; d < maxDepth; d++) {
    if (fa.length <= fb.length) fa = await expand(fa, prevA);
    else fb = await expand(fb, prevB);
    const meet = [...prevA.keys()].find((k) => prevB.has(k));
    if (meet) {
      const pathNodes: string[] = [];
      const pathEdges: EdgeRow[] = [];
      for (let cur: string | undefined = meet; cur; ) {
        pathNodes.unshift(cur);
        const p = prevA.get(cur);
        if (p) pathEdges.unshift(p.edge);
        cur = p?.via;
      }
      for (let cur = prevB.get(meet); cur; cur = prevB.get(cur.via)) {
        pathNodes.push(cur.via);
        pathEdges.push(cur.edge);
      }
      const nodes = await db.graphNode.findMany({ where: { id: { in: pathNodes } }, select: nodeSelect });
      const byId = new Map(nodes.map((n) => [n.id, n]));
      return { nodes: pathNodes.map((id) => byId.get(id)).filter((n): n is NonNullable<typeof n> => Boolean(n)).map(nodeDTO), edges: pathEdges.map((e) => edgeDTO(e)) };
    }
    if (!fa.length || !fb.length) break;
  }
  return null;
}
