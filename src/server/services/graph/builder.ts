/**
 * Materialized graph builder (spec §7.7). Incremental: dirty node IDs → recompute those nodes and the edges they
 * own, upsert with a new `version` from graph_version_seq (unchanged rows keep their version), delete stale
 * edges (tombstoned), publish `graph.delta`.
 *
 * Undirected top-k kinds (SIMILAR, CO_TOPIC, TOPIC_RELATED, CO_DISCOVERED) record which endpoint(s) selected the
 * edge in `evidence.from`; recomputing X only withdraws X's vote, so the edge set is exactly the union of every
 * node's top-k.
 */
import { db, Prisma, type EdgeKind, type NodeType } from "@/server/db";
import { redis, key } from "@/server/redis";
import { log } from "@/server/logger";
import { knn, getVector } from "@/server/db/vector";
import { publish } from "@/server/services/realtime";
import { allowed as policyAllows } from "@/server/youtube/policy";
import { semanticAvailable } from "@/server/services/embeddings";

export const MIN_TOPIC_VIDEOS = 2;
const SIMILAR_MIN = 0.75;
const CO_TOPIC_MIN = 0.2;
const TOP_K = 10;
const CHANNEL_TOPIC_K = 15;
const NICHE_TOPIC_K = 10;
const CO_DISCOVERED_WEIGHT = 0.2;

export type NodeKey = `${"niche" | "subniche" | "channel" | "video" | "topic"}:${string}`;

export const UNDIRECTED: ReadonlySet<EdgeKind> = new Set<EdgeKind>(["SIMILAR", "CO_TOPIC", "TOPIC_RELATED", "CO_DISCOVERED"]);

export function canonical(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}
export const edgeId = (kind: EdgeKind, s: string, t: string) => `${kind}|${s}|${t}`;

export function parseNodeId(id: string): { type: NodeType; ref: string } | null {
  const i = id.indexOf(":");
  if (i < 0) return null;
  const t = id.slice(0, i);
  const ref = id.slice(i + 1);
  const map: Record<string, NodeType> = { niche: "NICHE", subniche: "SUBNICHE", channel: "CHANNEL", video: "VIDEO", topic: "TOPIC" };
  return map[t] && ref ? { type: map[t]!, ref } : null;
}

interface NodeRow {
  id: string;
  type: NodeType;
  refId: string;
  label: string;
  size: number;
  attrs: Record<string, unknown>;
}
interface EdgeRow {
  sourceId: string;
  targetId: string;
  kind: EdgeKind;
  weight: number;
  evidence: Record<string, unknown> | null;
}

/** Top-k selection helper: ties broken by id for determinism. */
export function topK<T>(items: T[], k: number, score: (t: T) => number, id: (t: T) => string): T[] {
  return [...items].sort((a, b) => score(b) - score(a) || id(a).localeCompare(id(b))).slice(0, k);
}

/** Weighted Jaccard Σmin/Σmax over sparse vectors. */
export function weightedJaccard(a: Map<string, number>, b: Map<string, number>): { score: number; shared: string[] } {
  let mn = 0;
  let mx = 0;
  const shared: { k: string; w: number }[] = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(k) ?? 0;
    const y = b.get(k) ?? 0;
    mn += Math.min(x, y);
    mx += Math.max(x, y);
    if (x > 0 && y > 0) shared.push({ k, w: Math.min(x, y) });
  }
  return { score: mx ? mn / mx : 0, shared: shared.sort((p, q) => q.w - p.w).map((s) => s.k) };
}

/** Normalized PMI in [-1, 1] from co-occurrence counts. */
export function npmi(co: number, ca: number, cb: number, n: number): number {
  if (!co || !ca || !cb || !n) return -1;
  const pab = co / n;
  const pmi = Math.log(pab / ((ca / n) * (cb / n)));
  const denom = -Math.log(pab);
  return denom === 0 ? 1 : pmi / denom;
}

const num = (v: bigint | number | null | undefined) => (v === null || v === undefined ? null : Number(v));

// ── Node computation ───────────────────────────────────────────────────────

async function nodeFor(id: string): Promise<NodeRow | null> {
  const p = parseNodeId(id);
  if (!p) return null;
  switch (p.type) {
    case "NICHE":
    case "SUBNICHE": {
      const n = await db.niche.findUnique({ where: { slug: p.ref }, select: { slug: true, name: true, description: true, channelCount: true, depth: true, parent: { select: { slug: true } } } });
      if (!n || (n.depth === 0) !== (p.type === "NICHE")) return null;
      return {
        id,
        type: p.type,
        refId: n.slug,
        label: n.name,
        size: p.type === "NICHE" ? 28 + Math.log2(1 + n.channelCount) * 2 : 14 + Math.log2(1 + n.channelCount) * 2,
        attrs: { description: n.description, channelCount: n.channelCount, parent: n.parent?.slug ?? null },
      };
    }
    case "CHANNEL": {
      const c = await db.channel.findUnique({
        where: { youtubeId: p.ref },
        select: {
          id: true,
          youtubeId: true,
          title: true,
          handle: true,
          thumbnailUrl: true,
          subscriberCount: true,
          videoCount: true,
          viewCount: true,
          latestVideoAt: true,
          isAvailable: true,
          country: true,
          niches: { select: { confidence: true, niche: { select: { slug: true, parent: { select: { slug: true } } } } }, orderBy: { confidence: "desc" } },
          _count: { select: { videos: { where: { hasTranscript: true } } } },
        },
      });
      if (!c || !c.isAvailable) return null;
      const subs = num(c.subscriberCount);
      return {
        id,
        type: "CHANNEL",
        refId: c.youtubeId,
        label: c.title,
        size: 4 + Math.max(0, Math.log10(Math.max(subs ?? 1000, 1)) - 2) * 3,
        attrs: {
          channelId: c.id,
          handle: c.handle,
          thumbnailUrl: c.thumbnailUrl,
          subscriberCount: subs,
          videoCount: c.videoCount,
          viewCount: num(c.viewCount),
          latestVideoAt: c.latestVideoAt?.toISOString() ?? null,
          country: c.country,
          subniches: c.niches.map((n) => n.niche.slug),
          niches: [...new Set(c.niches.map((n) => n.niche.parent?.slug).filter(Boolean))],
          transcriptVideos: c._count.videos,
        },
      };
    }
    case "VIDEO": {
      const v = await db.video.findUnique({
        where: { youtubeId: p.ref },
        select: { id: true, youtubeId: true, title: true, thumbnailUrl: true, publishedAt: true, viewCount: true, durationSec: true, hasTranscript: true, isShort: true, isAvailable: true, channel: { select: { youtubeId: true, title: true } } },
      });
      if (!v || !v.isAvailable) return null;
      const views = num(v.viewCount) ?? 0;
      return {
        id,
        type: "VIDEO",
        refId: v.youtubeId,
        label: v.title,
        size: 2 + Math.max(0, Math.log10(Math.max(views, 1)) - 2) * 0.8,
        attrs: { videoId: v.id, thumbnailUrl: v.thumbnailUrl, publishedAt: v.publishedAt.toISOString(), viewCount: views, durationSec: v.durationSec, hasTranscript: v.hasTranscript, isShort: v.isShort, channel: v.channel.youtubeId, channelTitle: v.channel.title },
      };
    }
    case "TOPIC": {
      const t = await db.topic.findUnique({ where: { slug: p.ref }, select: { slug: true, label: true, aliases: true, videoCount: true, channelCount: true } });
      if (!t || t.videoCount < MIN_TOPIC_VIDEOS) return null;
      return { id, type: "TOPIC", refId: t.slug, label: t.label, size: 3 + Math.log2(1 + t.videoCount) * 1.2, attrs: { videoCount: t.videoCount, channelCount: t.channelCount, aliases: t.aliases.slice(0, 8) } };
    }
  }
}

// ── Edge computation (edges a node owns) ───────────────────────────────────

interface Owned {
  /** Directed edges fully owned by this node: replace all of (kind, side) for the node. */
  replace: { kind: EdgeKind; side: "source" | "target"; edges: EdgeRow[] }[];
  /** Undirected votes: this node's top-k picks for the kind. */
  votes: { kind: EdgeKind; picks: { other: string; weight: number; evidence: Record<string, unknown> }[] }[];
}

async function channelEdges(youtubeId: string, extraDirty: Set<string>): Promise<Owned> {
  const nodeId = `channel:${youtubeId}`;
  const c = await db.channel.findUnique({
    where: { youtubeId },
    select: { id: true, title: true, featuredChannelIds: true, niches: { select: { confidence: true, method: true, niche: { select: { slug: true, name: true, parent: { select: { slug: true } } } } } } },
  });
  if (!c) return { replace: [], votes: [] };
  c.niches.forEach((n) => {
    extraDirty.add(`subniche:${n.niche.slug}`);
    if (n.niche.parent) extraDirty.add(`niche:${n.niche.parent.slug}`);
  });

  const inNiche: EdgeRow[] = c.niches.map((n) => ({ sourceId: `subniche:${n.niche.slug}`, targetId: nodeId, kind: "IN_NICHE", weight: +n.confidence.toFixed(3), evidence: { method: n.method } }));

  const vids = await db.video.findMany({ where: { channelId: c.id, isAvailable: true }, select: { youtubeId: true, viewCount: true, publishedAt: true } });
  const maxViews = Math.max(1, ...vids.map((v) => Number(v.viewCount ?? 0)));
  const newest = Math.max(...vids.map((v) => v.publishedAt.getTime()), 0);
  const published: EdgeRow[] = vids.map((v) => {
    const pop = Math.log1p(Number(v.viewCount ?? 0)) / Math.log1p(maxViews);
    const rec = Math.exp(-(newest - v.publishedAt.getTime()) / (180 * 86_400_000));
    return { sourceId: nodeId, targetId: `video:${v.youtubeId}`, kind: "PUBLISHED", weight: +(0.5 * pop + 0.5 * rec).toFixed(3), evidence: null };
  });

  // Aggregated channel → topic (materialized topics only), top 15.
  const agg = await db.$queryRaw<{ slug: string; label: string; w: number; n: number }[]>`
    SELECT t.slug, t.label, sum(vt.weight)::float AS w, count(*)::int AS n
    FROM "VideoTopic" vt JOIN "Video" v ON v.id = vt."videoId" JOIN "Topic" t ON t.id = vt."topicId"
    WHERE v."channelId" = ${c.id} AND t."videoCount" >= ${MIN_TOPIC_VIDEOS}
    GROUP BY t.slug, t.label ORDER BY w DESC, t.slug LIMIT ${CHANNEL_TOPIC_K}`;
  const maxW = agg[0]?.w ?? 1;
  const channelTopic: EdgeRow[] = agg.map((a) => ({ sourceId: nodeId, targetId: `topic:${a.slug}`, kind: "CHANNEL_TOPIC", weight: +(a.w / maxW).toFixed(3), evidence: { videos: a.n } }));

  // FEATURED: outgoing from this channel's sections; incoming from channels that feature it.
  const featuredOut = await db.channel.findMany({ where: { youtubeId: { in: c.featuredChannelIds } }, select: { youtubeId: true } });
  const featuredIn = await db.channel.findMany({ where: { featuredChannelIds: { has: youtubeId } }, select: { youtubeId: true, title: true } });
  const featOut: EdgeRow[] = featuredOut.map((f) => ({ sourceId: nodeId, targetId: `channel:${f.youtubeId}`, kind: "FEATURED", weight: 1, evidence: { by: c.title } }));
  const featIn: EdgeRow[] = featuredIn.map((f) => ({ sourceId: `channel:${f.youtubeId}`, targetId: nodeId, kind: "FEATURED", weight: 1, evidence: { by: f.title } }));

  // SIMILAR via pgvector KNN.
  // Never compare vectors from different embedding models (D4): no SIMILAR edges while a reindex is pending.
  const vec = (await semanticAvailable()) ? await getVector("Channel", c.id) : null;
  const similar: Owned["votes"][number]["picks"] = [];
  if (vec) {
    const hits = await knn("Channel", vec, TOP_K, { excludeId: c.id, where: Prisma.sql`"isAvailable" = true` });
    const ids = hits.filter((h) => h.similarity >= SIMILAR_MIN);
    const rows = await db.channel.findMany({ where: { id: { in: ids.map((h) => h.id) } }, select: { id: true, youtubeId: true } });
    const byId = new Map(rows.map((r) => [r.id, r.youtubeId]));
    for (const h of ids) {
      const yt = byId.get(h.id);
      if (yt) similar.push({ other: `channel:${yt}`, weight: +h.similarity.toFixed(4), evidence: { similarity: +h.similarity.toFixed(3) } });
    }
  }

  // CO_TOPIC: weighted Jaccard over aggregated topic weights.
  const mine = new Map(agg.map((a) => [a.slug, a.w / maxW]));
  const coTopic: Owned["votes"][number]["picks"] = [];
  if (mine.size) {
    const others = await db.$queryRaw<{ youtubeId: string; slug: string; w: number }[]>`
      WITH cand AS (
        SELECT DISTINCT v."channelId" FROM "VideoTopic" vt JOIN "Video" v ON v.id = vt."videoId" JOIN "Topic" t ON t.id = vt."topicId"
        WHERE t.slug = ANY(${[...mine.keys()]}) AND v."channelId" <> ${c.id}
      ), agg AS (
        SELECT v."channelId", t.slug, sum(vt.weight)::float AS w,
               row_number() OVER (PARTITION BY v."channelId" ORDER BY sum(vt.weight) DESC, t.slug) AS rn
        FROM "VideoTopic" vt JOIN "Video" v ON v.id = vt."videoId" JOIN "Topic" t ON t.id = vt."topicId"
        WHERE v."channelId" IN (SELECT "channelId" FROM cand) AND t."videoCount" >= ${MIN_TOPIC_VIDEOS}
        GROUP BY v."channelId", t.slug
      )
      SELECT ch."youtubeId", agg.slug, agg.w FROM agg JOIN "Channel" ch ON ch.id = agg."channelId" WHERE agg.rn <= ${CHANNEL_TOPIC_K}`;
    const vecs = new Map<string, Map<string, number>>();
    for (const o of others) {
      let m = vecs.get(o.youtubeId);
      if (!m) vecs.set(o.youtubeId, (m = new Map()));
      m.set(o.slug, o.w);
    }
    const scored: { other: string; score: number; shared: string[] }[] = [];
    for (const [yt, m] of vecs) {
      const mx = Math.max(...m.values());
      for (const [k, w] of m) m.set(k, w / mx);
      const j = weightedJaccard(mine, m);
      if (j.score >= CO_TOPIC_MIN) scored.push({ other: `channel:${yt}`, score: j.score, shared: j.shared });
    }
    const labels = new Map(agg.map((a) => [a.slug, a.label]));
    for (const s of topK(scored, TOP_K, (x) => x.score, (x) => x.other)) {
      coTopic.push({ other: s.other, weight: +s.score.toFixed(4), evidence: { shared: s.shared.slice(0, 5).map((k) => labels.get(k) ?? k) } });
    }
  }

  // CO_DISCOVERED: appeared together in discovery results.
  const queries = await db.discoveryQuery.findMany({ where: { resultChannelIds: { has: youtubeId } }, select: { query: true, resultChannelIds: true }, orderBy: { createdAt: "desc" }, take: 50 });
  const co = new Map<string, string>();
  for (const q of queries) for (const other of q.resultChannelIds) if (other !== youtubeId && !co.has(other)) co.set(other, q.query);
  const existing = co.size ? await db.channel.findMany({ where: { youtubeId: { in: [...co.keys()] } }, select: { youtubeId: true } }) : [];
  const coDisc = existing.slice(0, 25).map((e) => ({ other: `channel:${e.youtubeId}`, weight: CO_DISCOVERED_WEIGHT, evidence: { query: co.get(e.youtubeId) } }));

  return {
    replace: [
      { kind: "IN_NICHE", side: "target", edges: inNiche },
      { kind: "PUBLISHED", side: "source", edges: published },
      { kind: "CHANNEL_TOPIC", side: "source", edges: channelTopic },
      { kind: "FEATURED", side: "source", edges: featOut },
      { kind: "FEATURED", side: "target", edges: featIn },
    ],
    // Cross-owner relationships are policy-gated for live data (docs/COMPLIANCE_DECISIONS.md §10). An empty vote
    // withdraws this node's previous picks, so flipping the gate off also cleans up existing edges on rebuild.
    votes: policyAllows("cross-owner-aggregation")
      ? [
          { kind: "SIMILAR", picks: similar },
          { kind: "CO_TOPIC", picks: coTopic },
          { kind: "CO_DISCOVERED", picks: coDisc },
        ]
      : [
          { kind: "SIMILAR", picks: [] },
          { kind: "CO_TOPIC", picks: [] },
          { kind: "CO_DISCOVERED", picks: [] },
        ],
  };
}

async function videoEdges(youtubeId: string): Promise<Owned> {
  const nodeId = `video:${youtubeId}`;
  const v = await db.video.findUnique({ where: { youtubeId }, select: { id: true, channel: { select: { youtubeId: true } } } });
  if (!v) return { replace: [], votes: [] };
  const topics = await db.$queryRaw<{ slug: string; w: number; src: string }[]>`
    SELECT t.slug, max(vt.weight)::float AS w, string_agg(vt.source, ',') AS src FROM "VideoTopic" vt JOIN "Topic" t ON t.id = vt."topicId"
    WHERE vt."videoId" = ${v.id} AND t."videoCount" >= ${MIN_TOPIC_VIDEOS} GROUP BY t.slug`;
  return {
    replace: [{ kind: "MENTIONS", side: "source", edges: topics.map((t) => ({ sourceId: nodeId, targetId: `topic:${t.slug}`, kind: "MENTIONS", weight: +t.w.toFixed(3), evidence: { source: t.src } })) }],
    votes: [],
  };
}

async function topicEdges(slug: string): Promise<Owned> {
  const nodeId = `topic:${slug}`;
  const t = await db.topic.findUnique({ where: { slug }, select: { id: true, videoCount: true } });
  if (!t || t.videoCount < MIN_TOPIC_VIDEOS) return { replace: [], votes: [] };
  // MENTIONS into this topic (so a topic that just crossed the threshold gets its earlier links).
  const mentions = await db.$queryRaw<{ youtubeId: string; w: number }[]>`
    SELECT v."youtubeId", max(vt.weight)::float AS w FROM "VideoTopic" vt JOIN "Video" v ON v.id = vt."videoId"
    WHERE vt."topicId" = ${t.id} AND v."isAvailable" = true GROUP BY v."youtubeId"`;
  // TOPIC_RELATED via co-occurrence NPMI.
  const n = (await db.$queryRaw<{ n: number }[]>`SELECT count(DISTINCT "videoId")::int AS n FROM "VideoTopic"`)[0]?.n ?? 0;
  const co = await db.$queryRaw<{ slug: string; label: string; co: number; cnt: number }[]>`
    SELECT t2.slug, t2.label, count(DISTINCT a."videoId")::int AS co, t2."videoCount" AS cnt
    FROM "VideoTopic" a JOIN "VideoTopic" b ON a."videoId" = b."videoId" AND b."topicId" <> a."topicId"
    JOIN "Topic" t2 ON t2.id = b."topicId"
    WHERE a."topicId" = ${t.id} AND t2."videoCount" >= ${MIN_TOPIC_VIDEOS}
    GROUP BY t2.slug, t2.label, t2."videoCount" HAVING count(DISTINCT a."videoId") >= 2`;
  const scored = co.map((c) => ({ other: `topic:${c.slug}`, score: npmi(c.co, t.videoCount, c.cnt, n), co: c.co })).filter((c) => c.score > 0);
  return {
    replace: [{ kind: "MENTIONS", side: "target", edges: mentions.map((m) => ({ sourceId: `video:${m.youtubeId}`, targetId: nodeId, kind: "MENTIONS", weight: +m.w.toFixed(3), evidence: null })) }],
    votes: [{ kind: "TOPIC_RELATED", picks: !policyAllows("cross-owner-aggregation") ? [] : topK(scored, TOP_K, (x) => x.score, (x) => x.other).map((s) => ({ other: s.other, weight: +s.score.toFixed(4), evidence: { cooccurrences: s.co } })) }],
  };
}

async function nicheEdges(slug: string, isSub: boolean): Promise<Owned> {
  const nodeId = `${isSub ? "subniche" : "niche"}:${slug}`;
  const n = await db.niche.findUnique({ where: { slug }, select: { id: true, slug: true, children: { select: { slug: true } }, parent: { select: { slug: true } } } });
  if (!n) return { replace: [], votes: [] };
  if (!isSub) {
    return { replace: [{ kind: "CONTAINS", side: "source", edges: n.children.map((c) => ({ sourceId: nodeId, targetId: `subniche:${c.slug}`, kind: "CONTAINS", weight: 1, evidence: null })) }], votes: [] };
  }
  const agg = await db.$queryRaw<{ slug: string; w: number }[]>`
    SELECT t.slug, sum(vt.weight * cn.confidence)::float AS w
    FROM "ChannelNiche" cn JOIN "Video" v ON v."channelId" = cn."channelId"
    JOIN "VideoTopic" vt ON vt."videoId" = v.id JOIN "Topic" t ON t.id = vt."topicId"
    WHERE cn."nicheId" = ${n.id} AND t."videoCount" >= ${MIN_TOPIC_VIDEOS} AND t."channelCount" >= 1
    GROUP BY t.slug ORDER BY w DESC, t.slug LIMIT ${NICHE_TOPIC_K}`;
  const max = agg[0]?.w ?? 1;
  const nicheTopics = policyAllows("cross-owner-aggregation") ? agg : [];
  return {
    replace: [
      { kind: "NICHE_TOPIC", side: "source", edges: nicheTopics.map((a) => ({ sourceId: nodeId, targetId: `topic:${a.slug}`, kind: "NICHE_TOPIC", weight: +(a.w / max).toFixed(3), evidence: null })) },
      ...(n.parent ? [{ kind: "CONTAINS" as const, side: "target" as const, edges: [{ sourceId: `niche:${n.parent.slug}`, targetId: nodeId, kind: "CONTAINS" as const, weight: 1, evidence: null }] }] : []),
    ],
    votes: [],
  };
}

// ── Persistence ────────────────────────────────────────────────────────────

export async function nextVersion(): Promise<bigint> {
  const [r] = await db.$queryRaw<{ v: bigint }[]>`SELECT nextval('graph_version_seq') AS v`;
  return r!.v;
}

async function upsertNodes(rows: NodeRow[], version: bigint): Promise<string[]> {
  const changed: string[] = [];
  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200);
    const values = Prisma.join(batch.map((n) => Prisma.sql`(${n.id}, ${n.type}::"NodeType", ${n.refId}, ${n.label}, ${n.size}, ${JSON.stringify(n.attrs)}::jsonb, ${version}, now())`));
    const res = await db.$queryRaw<{ id: string }[]>`
      INSERT INTO "GraphNode" (id, type, "refId", label, size, attrs, version, "updatedAt") VALUES ${values}
      ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, size = EXCLUDED.size, attrs = EXCLUDED.attrs, version = EXCLUDED.version, "updatedAt" = now()
      WHERE "GraphNode".label IS DISTINCT FROM EXCLUDED.label OR abs("GraphNode".size - EXCLUDED.size) > 1e-6 OR "GraphNode".attrs IS DISTINCT FROM EXCLUDED.attrs
      RETURNING id`;
    changed.push(...res.map((r) => r.id));
  }
  return changed;
}

async function upsertEdges(rows: EdgeRow[], version: bigint): Promise<number> {
  let n = 0;
  for (let i = 0; i < rows.length; i += 300) {
    const batch = rows.slice(i, i + 300);
    const values = Prisma.join(
      batch.map((e) => Prisma.sql`(${edgeId(e.kind, e.sourceId, e.targetId)}, ${e.sourceId}, ${e.targetId}, ${e.kind}::"EdgeKind", ${e.weight}, ${e.evidence ? JSON.stringify(e.evidence) : null}::jsonb, ${version}, now())`),
    );
    const res = await db.$executeRaw`
      INSERT INTO "GraphEdge" (id, "sourceId", "targetId", kind, weight, evidence, version, "updatedAt") VALUES ${values}
      ON CONFLICT (id) DO UPDATE SET weight = EXCLUDED.weight, evidence = EXCLUDED.evidence, version = EXCLUDED.version, "updatedAt" = now()
      WHERE abs("GraphEdge".weight - EXCLUDED.weight) > 1e-6 OR "GraphEdge".evidence IS DISTINCT FROM EXCLUDED.evidence`;
    n += res;
  }
  return n;
}

export async function deleteEdges(ids: string[], version: bigint) {
  if (!ids.length) return 0;
  await db.graphEdge.deleteMany({ where: { id: { in: ids } } });
  await db.graphTombstone.createMany({ data: ids.map((refId) => ({ kind: "edge", refId, version })) });
  return ids.length;
}

export async function deleteNodes(ids: string[], version: bigint) {
  if (!ids.length) return 0;
  const edges = await db.graphEdge.findMany({ where: { OR: [{ sourceId: { in: ids } }, { targetId: { in: ids } }] }, select: { id: true } });
  await deleteEdges(edges.map((e) => e.id), version);
  const res = await db.graphNode.deleteMany({ where: { id: { in: ids } } });
  await db.graphTombstone.createMany({ data: ids.map((refId) => ({ kind: "node", refId, version })) });
  return res.count;
}

export interface BuildStats {
  version: string;
  nodesChanged: number;
  nodesRemoved: number;
  edgesChanged: number;
  edgesRemoved: number;
  dirty: number;
  ms: number;
}

/** Recompute the given nodes (+ cascaded subniches) and their owned edges. */
export async function buildDirty(dirtyIds: string[]): Promise<BuildStats> {
  const t0 = performance.now();
  const version = await nextVersion();
  const dirty = new Set(dirtyIds.filter((id) => parseNodeId(id)));
  const cascaded = new Set<string>();
  const nodes: NodeRow[] = [];
  const missing: string[] = [];
  const owned = new Map<string, Owned>();

  const process = async (id: string) => {
    const node = await nodeFor(id);
    if (!node) {
      missing.push(id);
      return;
    }
    nodes.push(node);
    const p = parseNodeId(id)!;
    owned.set(
      id,
      p.type === "CHANNEL" ? await channelEdges(p.ref, cascaded) : p.type === "VIDEO" ? await videoEdges(p.ref) : p.type === "TOPIC" ? await topicEdges(p.ref) : await nicheEdges(p.ref, p.type === "SUBNICHE"),
    );
  };
  for (const id of dirty) await process(id);
  for (const id of cascaded) if (!dirty.has(id)) await process(id);

  const nodesChanged = await upsertNodes(nodes, version);
  const nodesRemoved = await deleteNodes(missing, version);

  // Edges may only connect existing nodes.
  const exists = async (ids: string[]) => new Set((await db.graphNode.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true } })).map((n) => n.id));

  let edgesChanged = 0;
  let edgesRemoved = 0;
  for (const [id, o] of owned) {
    // Directed, fully-owned edge sets.
    for (const r of o.replace) {
      const ok = await exists(r.edges.flatMap((e) => [e.sourceId, e.targetId]));
      const desired = r.edges.filter((e) => ok.has(e.sourceId) && ok.has(e.targetId));
      const current = await db.graphEdge.findMany({ where: { kind: r.kind, ...(r.side === "source" ? { sourceId: id } : { targetId: id }) }, select: { id: true } });
      const keep = new Set(desired.map((e) => edgeId(e.kind, e.sourceId, e.targetId)));
      edgesRemoved += await deleteEdges(current.filter((c) => !keep.has(c.id)).map((c) => c.id), version);
      edgesChanged += await upsertEdges(desired, version);
    }
    // Undirected votes with provenance.
    for (const v of o.votes) {
      const ok = await exists(v.picks.map((p) => p.other));
      const picks = v.picks.filter((p) => ok.has(p.other));
      const current = await db.graphEdge.findMany({ where: { kind: v.kind, OR: [{ sourceId: id }, { targetId: id }] }, select: { id: true, sourceId: true, targetId: true, weight: true, evidence: true } });
      const desired = new Map(picks.map((p) => {
        const [s, t] = canonical(id, p.other);
        return [edgeId(v.kind, s, t), { s, t, p }] as const;
      }));
      const toDelete: string[] = [];
      const toUpsert: EdgeRow[] = [];
      for (const e of current) {
        const ev = (e.evidence ?? {}) as { from?: string[] };
        const from = new Set(ev.from ?? []);
        if (desired.has(e.id)) continue;
        from.delete(id);
        if (!from.size) toDelete.push(e.id);
        else toUpsert.push({ sourceId: e.sourceId, targetId: e.targetId, kind: v.kind, weight: e.weight, evidence: { ...(e.evidence as object), from: [...from].sort() } });
      }
      const currentById = new Map(current.map((e) => [e.id, e]));
      for (const [eid, { s, t, p }] of desired) {
        const prev = currentById.get(eid);
        const from = new Set(((prev?.evidence ?? {}) as { from?: string[] }).from ?? []);
        from.add(id);
        toUpsert.push({ sourceId: s, targetId: t, kind: v.kind, weight: p.weight, evidence: { ...p.evidence, from: [...from].sort() } });
      }
      edgesRemoved += await deleteEdges(toDelete, version);
      edgesChanged += await upsertEdges(toUpsert, version);
    }
  }

  await redis.set(key("graph", "version"), version.toString());
  const changedIds = [...new Set([...nodesChanged, ...missing])];
  const stats: BuildStats = { version: version.toString(), nodesChanged: nodesChanged.length, nodesRemoved, edgesChanged, edgesRemoved, dirty: dirty.size + cascaded.size, ms: Math.round(performance.now() - t0) };
  if (stats.nodesChanged || stats.nodesRemoved || stats.edgesChanged || stats.edgesRemoved) {
    await publish({ type: "graph.delta", scope: "global", payload: { fromVersion: (version - 1n).toString(), toVersion: version.toString(), nodeIds: changedIds.slice(0, 500), edgesChanged: stats.edgesChanged, edgesRemoved: stats.edgesRemoved } });
  }
  log().info(stats, "graph build");
  return stats;
}

/** Drain the debounced dirty set (graph-build job). */
export async function buildFromDirtySet(): Promise<BuildStats | null> {
  const k = key("graph", "dirty");
  const total: string[] = [];
  for (;;) {
    const ids = await redis.spop(k, 1000);
    if (!ids.length) break;
    total.push(...ids);
  }
  if (!total.length) {
    await redis.del(key("graph", "dirty-since"));
    return null;
  }
  const stats = await buildDirty(total);
  // Clear the staleness marker unless new ids arrived while building (D12: stale-graph alert).
  if (!(await redis.scard(k))) await redis.del(key("graph", "dirty-since"));
  return stats;
}

/** Every node ID that should exist, in dependency-friendly order. */
export async function allNodeIds(): Promise<string[]> {
  const [niches, channels, videos, topics] = await Promise.all([
    db.niche.findMany({ select: { slug: true, depth: true } }),
    db.channel.findMany({ where: { isAvailable: true }, select: { youtubeId: true } }),
    db.video.findMany({ where: { isAvailable: true }, select: { youtubeId: true } }),
    db.topic.findMany({ where: { videoCount: { gte: MIN_TOPIC_VIDEOS } }, select: { slug: true } }),
  ]);
  return [
    ...niches.filter((n) => n.depth === 0).map((n) => `niche:${n.slug}`),
    ...niches.filter((n) => n.depth === 1).map((n) => `subniche:${n.slug}`),
    ...videos.map((v) => `video:${v.youtubeId}`),
    ...topics.map((t) => `topic:${t.slug}`),
    ...channels.map((c) => `channel:${c.youtubeId}`),
  ];
}

/** Full rebuild (pnpm graph:rebuild): builds everything in two passes (nodes exist before edges), then sweeps orphans. */
export async function rebuildAll(onProgress?: (done: number, total: number) => void): Promise<BuildStats> {
  const ids = await allNodeIds();
  const t0 = performance.now();
  const agg: BuildStats = { version: "0", nodesChanged: 0, nodesRemoved: 0, edgesChanged: 0, edgesRemoved: 0, dirty: 0, ms: 0 };
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < ids.length; i += 250) {
      const s = await buildDirty(ids.slice(i, i + 250));
      agg.version = s.version;
      agg.nodesChanged += s.nodesChanged;
      agg.nodesRemoved += s.nodesRemoved;
      agg.edgesChanged += s.edgesChanged;
      agg.edgesRemoved += s.edgesRemoved;
      agg.dirty += s.dirty;
      onProgress?.(pass * ids.length + Math.min(ids.length, i + 250), ids.length * 2);
    }
  }
  const valid = new Set(ids);
  const orphans = (await db.graphNode.findMany({ select: { id: true } })).filter((n) => !valid.has(n.id)).map((n) => n.id);
  if (orphans.length) agg.nodesRemoved += await deleteNodes(orphans, await nextVersion());
  agg.ms = Math.round(performance.now() - t0);
  return agg;
}

/** Remove tombstones older than `days` (clients that far behind do a full reload). */
export async function pruneTombstones(days = 7) {
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const [m] = await db.$queryRaw<{ v: bigint | null }[]>`SELECT max(version) AS v FROM "GraphTombstone" WHERE "createdAt" < ${cutoff}`;
  if (m?.v) await redis.set(key("graph", "tombstones-pruned-before"), m.v.toString());
  return db.graphTombstone.deleteMany({ where: { createdAt: { lt: cutoff } } });
}
