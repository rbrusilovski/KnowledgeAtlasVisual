/**
 * "Suggested subniches" (spec §7.5 stretch): Louvain over a similarity graph of low-confidence channels.
 * Edges come from the materialized SIMILAR / CO_TOPIC edges plus direct embedding cosine between candidates
 * (SIMILAR alone is too sparse at the 0.75 threshold). Clusters of ≥ 3 channels are proposed with a name derived
 * from their shared topics and the majority parent niche; an admin accepts (and names) or dismisses them.
 */
import { createHash } from "node:crypto";
import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { redis, key } from "@/server/redis";
import { enqueue } from "@/server/jobs";
import { log } from "@/server/logger";
import { getVector, normalize, setVector } from "@/server/db/vector";
import { getProvider } from "@/server/services/embeddings";
import { slugify } from "@/server/services/topics";
import { allowed as policyAllows } from "@/server/youtube/policy";

export interface SuggestionChannel {
  id: string;
  youtubeId: string;
  nodeId: string;
  title: string;
  thumbnailUrl: string | null;
  confidence: number;
  currentNiche: string | null;
}

export interface SubnicheSuggestion {
  id: string;
  name: string;
  keywords: string[];
  parentSlug: string | null;
  parentName: string | null;
  cohesion: number;
  channels: SuggestionChannel[];
}

export interface SuggestOptions {
  /** Channels whose best confidence is below this are candidates (default: CLASSIFY_MIN_CONFIDENCE + 0.2). */
  maxConfidence?: number;
  minClusterSize?: number;
  /** Embedding cosine needed to link two candidates (default depends on the provider). */
  minSimilarity?: number;
}

const DISMISSED = () => key("suggestions", "dismissed");
const titleCase = (s: string) => s.replace(/\b\w/g, (m) => m.toUpperCase());

export const suggestionId = (channelIds: string[]) => createHash("sha1").update([...channelIds].sort().join(",")).digest("hex").slice(0, 12);

export async function suggestSubniches(opts: SuggestOptions = {}): Promise<SubnicheSuggestion[]> {
  if (!policyAllows("cross-owner-aggregation")) return [];
  const maxConf = opts.maxConfidence ?? Math.min(0.6, env.CLASSIFY_MIN_CONFIDENCE + 0.2);
  const minSize = opts.minClusterSize ?? 3;
  const minSim = opts.minSimilarity ?? (getProvider().name.startsWith("local") ? 0.45 : 0.15);

  // Candidates: best automatic label is weak (or flagged), and no manual override.
  const rows = await db.$queryRaw<{ id: string; youtubeId: string; title: string; thumbnailUrl: string | null; best: number | null; slug: string | null; parentSlug: string | null; manual: boolean }[]>`
    SELECT c.id, c."youtubeId", c.title, c."thumbnailUrl",
      max(cn.confidence) AS best,
      (array_agg(n.slug ORDER BY cn.confidence DESC))[1] AS slug,
      (array_agg(p.slug ORDER BY cn.confidence DESC))[1] AS "parentSlug",
      bool_or(cn.method = 'MANUAL') AS manual
    FROM "Channel" c
    LEFT JOIN "ChannelNiche" cn ON cn."channelId" = c.id
    LEFT JOIN "Niche" n ON n.id = cn."nicheId"
    LEFT JOIN "Niche" p ON p.id = n."parentId"
    WHERE c."isAvailable"
    GROUP BY c.id
    HAVING (max(cn.confidence) IS NULL OR max(cn.confidence) < ${maxConf} OR bool_or(cn."lowConfidence")) AND NOT coalesce(bool_or(cn.method = 'MANUAL'), false)
    LIMIT 500`;
  if (rows.length < minSize) return [];
  const ids = rows.map((r) => r.id);

  const g = new Graph({ type: "undirected" });
  for (const r of rows) g.addNode(r.id);
  const addWeight = (a: string, b: string, w: number) => {
    if (a === b || !g.hasNode(a) || !g.hasNode(b)) return;
    if (g.hasEdge(a, b)) g.updateEdgeAttribute(a, b, "weight", (x: number | undefined) => (x ?? 0) + w);
    else g.addEdge(a, b, { weight: w });
  };
  const pairs = await db.$queryRaw<{ a: string; b: string; sim: number }[]>`
    SELECT x.id AS a, y.id AS b, 1 - (x.embedding <=> y.embedding) AS sim
    FROM "Channel" x JOIN "Channel" y ON x.id < y.id
    WHERE x.id = ANY(${ids}) AND y.id = ANY(${ids}) AND x.embedding IS NOT NULL AND y.embedding IS NOT NULL`;
  for (const p of pairs) if (p.sim >= minSim) addWeight(p.a, p.b, p.sim);
  const byYt = new Map(rows.map((r) => [`channel:${r.youtubeId}`, r.id]));
  const edges = await db.graphEdge.findMany({ where: { kind: { in: ["SIMILAR", "CO_TOPIC"] }, sourceId: { in: [...byYt.keys()] }, targetId: { in: [...byYt.keys()] } }, select: { sourceId: true, targetId: true, weight: true } });
  for (const e of edges) addWeight(byYt.get(e.sourceId)!, byYt.get(e.targetId)!, e.weight);
  if (!g.size) return [];

  const communities = louvain(g, { getEdgeWeight: "weight", rng: () => 0.42 });
  const clusters = new Map<number, string[]>();
  for (const [id, c] of Object.entries(communities)) if (g.degree(id) > 0) clusters.set(c, [...(clusters.get(c) ?? []), id]);

  const dismissed = new Set(await redis.smembers(DISMISSED()));
  const parentNames = new Map((await db.niche.findMany({ where: { depth: 0 }, select: { slug: true, name: true } })).map((n) => [n.slug, n.name]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: SubnicheSuggestion[] = [];
  for (const members of clusters.values()) {
    if (members.length < minSize) continue;
    const id = suggestionId(members);
    if (dismissed.has(id)) continue;
    const topics = await db.$queryRaw<{ label: string; w: number; n: number }[]>`
      SELECT t.label, sum(vt.weight)::float AS w, count(DISTINCT v."channelId")::int AS n
      FROM "VideoTopic" vt JOIN "Video" v ON v.id = vt."videoId" JOIN "Topic" t ON t.id = vt."topicId"
      WHERE v."channelId" = ANY(${members}) AND t."videoCount" >= 2
      GROUP BY t.label ORDER BY count(DISTINCT v."channelId") DESC, sum(vt.weight) DESC LIMIT 15`;
    const parents = members.map((m) => byId.get(m)!.parentSlug).filter((p): p is string => Boolean(p));
    const parentSlug = parents.length ? [...parents.reduce((m, p) => m.set(p, (m.get(p) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1])[0]![0] : null;
    let internal = 0;
    for (const a of members) for (const b of members) if (a < b && g.hasEdge(a, b)) internal += g.getEdgeAttribute(a, b, "weight") as number;
    const possible = (members.length * (members.length - 1)) / 2;
    out.push({
      id,
      name: topics.length ? titleCase(topics.slice(0, 2).map((t) => t.label).join(" & ")) : `Cluster ${out.length + 1}`,
      keywords: topics.map((t) => t.label),
      parentSlug,
      parentName: parentSlug ? (parentNames.get(parentSlug) ?? parentSlug) : null,
      cohesion: +(internal / Math.max(1, possible)).toFixed(3),
      channels: members.map((m) => {
        const r = byId.get(m)!;
        return { id: r.id, youtubeId: r.youtubeId, nodeId: `channel:${r.youtubeId}`, title: r.title, thumbnailUrl: r.thumbnailUrl, confidence: +(r.best ?? 0).toFixed(3), currentNiche: r.slug };
      }),
    });
  }
  return out.sort((a, b) => b.channels.length - a.channels.length || b.cohesion - a.cohesion);
}

export async function dismissSuggestion(id: string) {
  await redis.sadd(DISMISSED(), id);
}

export interface AcceptInput {
  channelIds: string[];
  name: string;
  parentSlug: string;
  description?: string;
  keywords?: string[];
}

/**
 * Creates the subniche (centroid = normalized mean of member embeddings), then reclassifies members so the new
 * subniche competes fairly with existing ones. Members that still don't pick it up are linked with their computed score.
 */
export async function acceptSuggestion(input: AcceptInput, classify: (channelId: string) => Promise<unknown>, scoreFor: (channelId: string, nicheId: string) => Promise<number>, onCreated: () => void) {
  const parent = await db.niche.findFirst({ where: { slug: input.parentSlug, depth: 0 }, select: { id: true, slug: true } });
  if (!parent) throw new AppError("VALIDATION_ERROR", "Unknown parent niche");
  const channels = await db.channel.findMany({ where: { id: { in: input.channelIds } }, select: { id: true, youtubeId: true } });
  if (channels.length < 2) throw new AppError("VALIDATION_ERROR", "A subniche needs at least two existing channels");
  let slug = slugify(input.name.toLowerCase());
  for (let i = 2; await db.niche.findUnique({ where: { slug }, select: { id: true } }); i++) slug = `${slugify(input.name.toLowerCase())}-${i}`;
  const keywords = [...new Set([input.name.toLowerCase(), ...(input.keywords ?? [])])].slice(0, 30);
  const niche = await db.niche.create({
    data: {
      slug,
      name: input.name,
      description: input.description ?? `Channels about ${keywords.slice(1, 4).join(", ") || input.name.toLowerCase()} (accepted from a suggested cluster).`,
      keywords,
      discoveryQueries: [input.name, `${input.name} channel`, `${input.name} explained`],
      depth: 1,
      parentId: parent.id,
    },
    select: { id: true, slug: true },
  });
  const vecs = (await Promise.all(channels.map((c) => getVector("Channel", c.id)))).filter((v): v is number[] => Boolean(v));
  if (vecs.length) {
    const mean = vecs[0]!.map((_, i) => vecs.reduce((s, v) => s + v[i]!, 0) / vecs.length);
    await setVector("Niche", niche.id, normalize(mean));
    await db.niche.update({ where: { id: niche.id }, data: { centroidCount: vecs.length } });
  }
  onCreated();
  for (const c of channels) {
    await classify(c.id);
    const linked = await db.channelNiche.findUnique({ where: { channelId_nicheId: { channelId: c.id, nicheId: niche.id } } });
    if (!linked) {
      const confidence = await scoreFor(c.id, niche.id);
      await db.channelNiche.create({ data: { channelId: c.id, nicheId: niche.id, confidence, method: "EMBEDDING", lowConfidence: confidence < env.CLASSIFY_MIN_CONFIDENCE, rationale: "Member of an accepted suggested subniche" } });
    }
  }
  await enqueue.graph([`subniche:${niche.slug}`, `niche:${parent.slug}`, ...channels.map((c) => `channel:${c.youtubeId}`)]);
  await dismissSuggestion(suggestionId(input.channelIds));
  log().info({ slug: niche.slug, members: channels.length }, "suggested subniche accepted");
  return niche;
}
