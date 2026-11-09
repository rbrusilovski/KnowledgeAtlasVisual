/**
 * Retirement of the predefined demo taxonomy. Two steps, never combined:
 *   planSeedCleanup()          — dry run: exact rows/nodes/references affected + a plan hash.
 *   executeSeedCleanup(hash)   — deletes ONLY the planned rows, only if the plan is unchanged (hash match),
 *                                only when a validated dynamic taxonomy is active.
 * Targets are matched by the deterministic manifest (TAXONOMY slugs) AND origin = SEED — never by name resemblance.
 * Users, workspaces, collections, saved views, layouts, discovery history, channels and videos are never deleted;
 * user rows that point at retired nodes are reported and left in place.
 */
import { createHash } from "node:crypto";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { TAXONOMY } from "@/server/taxonomy";

export const SEED_MANIFEST: string[] = TAXONOMY.flatMap((n) => [n.slug, ...n.children.map((c) => c.slug)]).sort();

export interface SeedCleanupPlan {
  hash: string;
  ready: boolean;
  blockers: string[];
  niches: { slug: string; depth: number; name: string }[];
  manifestMissing: string[];
  channelNiche: { automatic: number; manual: number; manualRows: { channel: string; niche: string }[] };
  videoNiche: number;
  graph: { nodes: string[]; edges: number };
  userReferences: { collectionItems: number; nodeLayouts: number; savedViewsMentioning: number; discoveryQueries: number };
  dynamic: { niches: number; subniches: number; classifiedVideos: number; channelsWithoutDynamic: string[] };
}

export async function planSeedCleanup(): Promise<SeedCleanupPlan> {
  const niches = await db.niche.findMany({ where: { origin: "SEED", slug: { in: SEED_MANIFEST } }, orderBy: [{ depth: "desc" }, { slug: "asc" }], select: { id: true, slug: true, depth: true, name: true } });
  const ids = niches.map((n) => n.id);
  const nodeIds = niches.map((n) => `${n.depth === 0 ? "niche" : "subniche"}:${n.slug}`);
  const [auto, manualRows, videoNiche, graphNodes, edges, collectionItems, nodeLayouts, views, discovery, dyn, classified, channels] = await Promise.all([
    db.channelNiche.count({ where: { nicheId: { in: ids }, NOT: { method: "MANUAL" } } }),
    db.channelNiche.findMany({ where: { nicheId: { in: ids }, method: "MANUAL" }, select: { channel: { select: { title: true } }, niche: { select: { slug: true } } } }),
    db.videoNiche.count({ where: { nicheId: { in: ids } } }),
    db.graphNode.findMany({ where: { id: { in: nodeIds } }, select: { id: true } }),
    db.graphEdge.count({ where: { OR: [{ sourceId: { in: nodeIds } }, { targetId: { in: nodeIds } }] } }),
    db.collectionItem.count({ where: { nodeId: { in: nodeIds } } }),
    db.nodeLayout.count({ where: { nodeId: { in: nodeIds } } }),
    db.savedView.findMany({ select: { state: true } }),
    db.discoveryQuery.count({ where: { nicheId: { in: ids } } }),
    db.niche.groupBy({ by: ["depth"], where: { origin: "DYNAMIC", status: "ACTIVE" }, _count: true }),
    db.$queryRaw<{ n: number }[]>`SELECT count(DISTINCT vn."videoId")::int AS n FROM "VideoNiche" vn JOIN "Niche" n ON n.id = vn."nicheId" WHERE n.origin = 'DYNAMIC' AND n.status = 'ACTIVE'`,
    db.$queryRaw<{ title: string }[]>`
      SELECT c.title FROM "Channel" c WHERE EXISTS (SELECT 1 FROM "Video" v WHERE v."channelId" = c.id)
        AND NOT EXISTS (SELECT 1 FROM "ChannelNiche" cn JOIN "Niche" n ON n.id = cn."nicheId" WHERE cn."channelId" = c.id AND n.origin <> 'SEED')
      ORDER BY c.title`,
  ]);
  const savedViewsMentioning = views.filter((v) => nodeIds.some((id) => JSON.stringify(v.state).includes(`"${id}"`))).length;
  const dynamic = { niches: dyn.find((d) => d.depth === 0)?._count ?? 0, subniches: dyn.find((d) => d.depth === 1)?._count ?? 0, classifiedVideos: classified[0]!.n, channelsWithoutDynamic: channels.map((c) => c.title) };
  const blockers: string[] = [];
  if (env.TAXONOMY_MODE !== "dynamic") blockers.push("TAXONOMY_MODE is not dynamic (live reseeding would recreate the demo taxonomy)");
  if (!dynamic.niches || !dynamic.subniches) blockers.push("no active dynamic taxonomy — generate and validate one first");
  if (dynamic.channelsWithoutDynamic.length) blockers.push(`${dynamic.channelsWithoutDynamic.length} channel(s) with videos have no dynamic category yet`);
  if (manualRows.length) blockers.push(`${manualRows.length} MANUAL channel assignment(s) point at demo categories — reassign them first`);
  if (!niches.length) blockers.push("nothing to clean up");
  const body = { niches: niches.map((n) => n.slug), auto, manual: manualRows.length, videoNiche, nodes: graphNodes.map((g) => g.id).sort(), edges };
  return {
    hash: createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16),
    ready: blockers.length === 0,
    blockers,
    niches: niches.map(({ slug, depth, name }) => ({ slug, depth, name })),
    manifestMissing: SEED_MANIFEST.filter((s) => !niches.some((n) => n.slug === s)),
    channelNiche: { automatic: auto, manual: manualRows.length, manualRows: manualRows.map((r) => ({ channel: r.channel.title, niche: r.niche.slug })) },
    videoNiche,
    graph: { nodes: graphNodes.map((g) => g.id).sort(), edges },
    userReferences: { collectionItems, nodeLayouts, savedViewsMentioning, discoveryQueries: discovery },
    dynamic,
  };
}

/** Executes exactly the reviewed plan. Returns graph node ids to rebuild (they become tombstones). */
export async function executeSeedCleanup(confirmHash: string) {
  const plan = await planSeedCleanup();
  if (!plan.ready) throw new AppError("CONFLICT", "Seed cleanup is blocked", { blockers: plan.blockers });
  if (plan.hash !== confirmHash) throw new AppError("CONFLICT", "The cleanup plan changed since it was reviewed; re-run the dry run", { expected: plan.hash, got: confirmHash });
  const slugs = plan.niches.map((n) => n.slug);
  const deleted = await db.$transaction(async (tx) => {
    // children first, then parents; ChannelNiche / VideoNiche rows cascade. Restricted to SEED + manifest.
    const subs = await tx.niche.deleteMany({ where: { origin: "SEED", slug: { in: slugs }, depth: 1 } });
    const tops = await tx.niche.deleteMany({ where: { origin: "SEED", slug: { in: slugs }, depth: 0 } });
    return subs.count + tops.count;
  });
  return { deleted, nodeIds: plan.graph.nodes, plan };
}
