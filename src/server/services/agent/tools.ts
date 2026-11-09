/**
 * Claude-facing Atlas tools (prompt §11, plan Phase 5). Core logic stays in the existing services; this file only
 * validates untrusted input, scopes results to the token's user, and labels provenance.
 *
 *  • access "read"    — runs inside `readOnly()`: any database write throws (enforced by the Prisma guard in db.ts).
 *  • access "propose" — may only estimate or create PENDING proposals with source CLAUDE. Nothing executes until a
 *                       signed-in human approves the exact scope in Atlas. No tool can approve, reject or cancel.
 */
import { z } from "zod";
import { db, readOnly } from "@/server/db";
import { AppError, notFound } from "@/server/errors";
import { channelDetail, nicheDetail, topicDetail, findChannelId, findVideoId } from "@/server/services/catalog";
import { inspectAtlas, inspectNiche, inspectChannel, inspectVideo } from "@/server/services/coverage";
import { search } from "@/server/services/search";
import { getSubgraph, findPath, EDGE_PROVENANCE } from "@/server/services/graph";
import { createProposal, estimate, getProposal, listProposals, normalizeScope, scopeHash, toDTO, type Actor, type ExpansionScope } from "@/server/services/expansion";
import { usage } from "@/server/services/quota";
import { policyStatus } from "@/server/youtube";
import { CreateProposalBody, ExpansionScope as ExpansionScopeSchema } from "@/shared/contracts/expansion";
import { GraphQuery } from "@/shared/contracts/graph";
import { NodeId } from "@/shared/contracts/common";
import { SEARCH_TYPES } from "@/shared/contracts/search";
import type { AgentScope } from "@/shared/contracts/agent";
import type { EdgeKind } from "@/server/db";

export interface ToolContext {
  userId: string;
  scopes: AgentScope[];
  tokenId: string;
}

export interface AgentTool<I extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  access: "read" | "propose";
  input: I;
  run(input: z.infer<I>, ctx: ToolContext): Promise<unknown>;
}

const tool = <I extends z.ZodType>(t: AgentTool<I>): AgentTool<I> => t;
const agentActor = (ctx: ToolContext): Actor => ({ kind: "agent", userId: ctx.userId });

const EntityId = z.string().trim().min(1).max(100);

type EdgeLike = { kind: string; evidence?: unknown };
function withProvenance<E extends EdgeLike>(e: E) {
  const p = EDGE_PROVENANCE[e.kind as EdgeKind];
  return { ...e, provenance: p ? { label: p.label, basis: p.basis, method: p.method, explanation: p.explanation } : null };
}

/** Is this expansion redundant with what Atlas already has or is already doing? Read-only. */
async function redundancy(scope: ExpansionScope, userId: string) {
  const hash = scopeHash(scope);
  const duplicate = await db.expansionProposal.findFirst({
    where: { scopeHash: hash, status: { in: ["PENDING", "APPROVED", "RUNNING"] }, OR: [{ createdByUserId: userId }, { source: "SYSTEM" }] },
    select: { id: true, status: true, source: true },
  });
  const notes: string[] = [];
  let alreadyPresent: string[] = [];
  let missingFromAtlas: string[] = [];
  switch (scope.kind) {
    case "ADD_CHANNELS": {
      const ids = scope.channels.map((c) => c.youtubeId);
      alreadyPresent = (await db.channel.findMany({ where: { youtubeId: { in: ids } }, select: { youtubeId: true } })).map((c) => c.youtubeId);
      if (alreadyPresent.length) notes.push(`${alreadyPresent.length} of ${ids.length} channels are already in Atlas and would be skipped.`);
      break;
    }
    case "DISCOVER_CHANNELS": {
      const recent = await db.discoveryQuery.count({ where: { query: { in: scope.queries }, createdAt: { gt: new Date(Date.now() - 30 * 86_400_000) } } });
      if (recent) notes.push(`${recent} identical discovery quer${recent === 1 ? "y was" : "ies were"} run in the last 30 days; results may overlap.`);
      break;
    }
    case "BACKFILL_HISTORY": {
      const c = await db.channel.findUnique({ where: { youtubeId: scope.channelYoutubeId }, select: { history: { select: { state: true, pagesScanned: true, videosCollected: true } } } });
      if (!c) missingFromAtlas = [scope.channelYoutubeId];
      else if (c.history?.state === "COMPLETE_TO_SOURCE_LIMIT") notes.push("Upload history is already complete to the source limit; a backfill would collect nothing.");
      else if (c.history) notes.push(`History state ${c.history.state}: ${c.history.pagesScanned} pages scanned, ${c.history.videosCollected} videos collected.`);
      break;
    }
    case "SYNC_UPLOADS": {
      const rows = await db.channel.findMany({ where: { youtubeId: { in: scope.channelYoutubeIds } }, select: { youtubeId: true, lastSyncedAt: true } });
      const have = new Set(rows.map((r) => r.youtubeId));
      missingFromAtlas = scope.channelYoutubeIds.filter((id) => !have.has(id));
      const fresh = rows.filter((r) => r.lastSyncedAt && Date.now() - r.lastSyncedAt.getTime() < 6 * 3600_000).length;
      if (fresh) notes.push(`${fresh} channel(s) were synced in the last 6 hours.`);
      break;
    }
    case "REFRESH_METADATA": {
      const ch = await db.channel.findMany({ where: { youtubeId: { in: scope.channelYoutubeIds } }, select: { youtubeId: true } });
      const vids = await db.video.findMany({ where: { youtubeId: { in: scope.videoYoutubeIds } }, select: { youtubeId: true } });
      const have = new Set([...ch, ...vids].map((r) => r.youtubeId));
      missingFromAtlas = [...scope.channelYoutubeIds, ...scope.videoYoutubeIds].filter((id) => !have.has(id));
      break;
    }
  }
  if (missingFromAtlas.length) notes.push(`${missingFromAtlas.length} target(s) are not in Atlas; the proposal would be rejected at creation.`);
  if (duplicate) notes.push(`An identical proposal is already ${duplicate.status.toLowerCase()} (${duplicate.id}).`);
  return { redundant: Boolean(duplicate) || (scope.kind === "ADD_CHANNELS" && alreadyPresent.length === scope.channels.length), duplicateProposalId: duplicate?.id ?? null, alreadyPresent, missingFromAtlas, notes };
}

export const TOOLS: AgentTool[] = [
  tool({
    name: "atlas_get_overview",
    description: "Counts of channels, videos, topics, niches and graph size; coverage summary; quota remaining; policy gates; your pending/active proposals.",
    access: "read",
    input: z.object({}).strict(),
    async run(_i, ctx) {
      const [channels, videos, topics, niches, nodes, edges, coverage, quota, mine] = await Promise.all([
        db.channel.count(),
        db.video.count(),
        db.topic.count({ where: { videoCount: { gte: 2 } } }),
        db.niche.count(),
        db.graphNode.count(),
        db.graphEdge.count(),
        inspectAtlas(),
        usage(),
        db.expansionProposal.groupBy({ by: ["status"], where: { createdByUserId: ctx.userId }, _count: { _all: true } }),
      ]);
      return {
        totals: { channels, videos, topics, niches, graphNodes: nodes, graphEdges: edges },
        coverage,
        quota: quota.buckets,
        policy: policyStatus(),
        yourProposals: Object.fromEntries(mine.map((m) => [m.status, m._count._all])),
      };
    },
  }),
  tool({
    name: "atlas_inspect_coverage",
    description: "Field-level coverage (collected / missing / stale / unavailable / not requested), upload-history state, retention deadlines and pending approvals for the whole Atlas, a niche/subniche, a channel or a video.",
    access: "read",
    input: z.object({ scope: z.enum(["atlas", "niche", "channel", "video"]), id: EntityId.optional() }).strict(),
    async run(i) {
      if (i.scope === "atlas") return inspectAtlas();
      if (!i.id) throw new AppError("VALIDATION_ERROR", `id is required for scope=${i.scope}`);
      if (i.scope === "niche") return inspectNiche(i.id.replace(/^(sub)?niche:/, ""));
      if (i.scope === "channel") return inspectChannel(await findChannelId(i.id));
      return inspectVideo(await findVideoId(i.id));
    },
  }),
  tool({
    name: "atlas_get_channel",
    description: "Channel detail: YouTube metadata (official), Atlas niche labels with confidence and provenance (inferred), top topics, latest videos, last ingestion run.",
    access: "read",
    input: z.object({ id: EntityId.describe("UC… id, Atlas id, or channel:UC… node id") }).strict(),
    run: async (i) => channelDetail(await findChannelId(i.id)),
  }),
  tool({
    name: "atlas_get_niche",
    description: "Niche or subniche detail with its top channels and topics.",
    access: "read",
    input: z.object({ id: EntityId.describe("slug, Atlas id or niche:/subniche: node id") }).strict(),
    run: (i) => nicheDetail(i.id),
  }),
  tool({
    name: "atlas_get_topic",
    description: "Topic detail (Atlas-extracted) with the videos and channels that mention it.",
    access: "read",
    input: z.object({ id: EntityId.describe("slug, Atlas id or topic: node id") }).strict(),
    run: (i) => topicDetail(i.id),
  }),
  tool({
    name: "atlas_search_existing",
    description: "Search data already in Atlas (hybrid keyword + semantic). Never calls YouTube. Private transcripts appear only for tokens with the private-transcripts scope, and only the token owner's.",
    access: "read",
    input: z
      .object({
        q: z.string().trim().min(1).max(200),
        mode: z.enum(["hybrid", "keyword", "semantic"]).default("hybrid"),
        types: z.array(z.enum(SEARCH_TYPES)).max(SEARCH_TYPES.length).optional(),
        channelId: EntityId.optional(),
        limit: z.number().int().min(1).max(25).default(10),
      })
      .strict(),
    async run(i, ctx) {
      const channelId = i.channelId ? await findChannelId(i.channelId) : undefined;
      const types = i.types?.length ? i.types : [...SEARCH_TYPES];
      const viewer = { userId: ctx.scopes.includes("private-transcripts") ? ctx.userId : null };
      const r = await search({ q: i.q, mode: i.mode, types, limit: i.limit, filter: { channelId, viewer } });
      return { items: r.items, effectiveMode: r.effectiveMode, counts: r.counts };
    },
  }),
  tool({
    name: "atlas_get_graph_neighborhood",
    description: "Bounded local graph around a node (depth 1–2, ≤ 300 nodes). Every edge carries provenance: FACT (stated by YouTube) or INFERRED (generated by Atlas) with its method.",
    access: "read",
    input: z
      .object({
        nodeId: NodeId,
        depth: z.number().int().min(1).max(2).default(1),
        limit: z.number().int().min(10).max(300).default(100),
        edgeKinds: z.array(z.enum(Object.keys(EDGE_PROVENANCE) as [EdgeKind, ...EdgeKind[]])).optional(),
      })
      .strict(),
    async run(i) {
      const g = await getSubgraph(GraphQuery.parse({ mode: "local", focus: i.nodeId, depth: i.depth, limit: i.limit, edgeKinds: i.edgeKinds?.join(",") }));
      return { ...g, edges: g.edges.map(withProvenance) };
    },
  }),
  tool({
    name: "atlas_explain_relationship",
    description: "Explain how two nodes are connected: direct edges with evidence and FACT/INFERRED provenance, otherwise the shortest bounded path.",
    access: "read",
    input: z.object({ from: NodeId, to: NodeId, maxDepth: z.number().int().min(1).max(5).default(4) }).strict(),
    async run(i) {
      const direct = await db.graphEdge.findMany({
        where: { OR: [{ sourceId: i.from, targetId: i.to }, { sourceId: i.to, targetId: i.from }] },
        select: { id: true, sourceId: true, targetId: true, kind: true, weight: true, evidence: true },
        orderBy: { weight: "desc" },
      });
      if (direct.length) return { connected: true, direct: true, edges: direct.map((e) => withProvenance({ ...e, kind: e.kind as string })) };
      const path = await findPath(i.from, i.to, i.maxDepth);
      if (!path) return { connected: false, direct: false, edges: [], note: `No path within ${i.maxDepth} hops (PUBLISHED edges are not traversed).` };
      return { connected: true, direct: false, hops: path.edges.length, nodes: path.nodes.map((n) => ({ id: n.id, type: n.type, label: n.label })), edges: path.edges.map(withProvenance) };
    },
  }),
  tool({
    name: "atlas_get_proposal_status",
    description: "Status, approved scope, progress and actual results of one of your expansion proposals.",
    access: "read",
    input: z.object({ id: EntityId }).strict(),
    run: (i, ctx) => getProposal(i.id, agentActor(ctx)),
  }),
  tool({
    name: "atlas_list_proposals",
    description: "Your expansion proposals (newest first), optionally filtered by status.",
    access: "read",
    input: z.object({ status: z.enum(["PENDING", "APPROVED", "REJECTED", "EXPIRED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED", "active"]).optional(), limit: z.number().int().min(1).max(50).default(20) }).strict(),
    run: (i, ctx) => listProposals(agentActor(ctx), { status: i.status, limit: i.limit }),
  }),
  tool({
    name: "atlas_get_ingestion_run",
    description: "One ingestion run (pages scanned, videos collected, quota used, errors) — runs you requested or that belong to your proposals.",
    access: "read",
    input: z.object({ id: EntityId }).strict(),
    async run(i, ctx) {
      const run = await db.ingestionRun.findUnique({ where: { id: i.id } });
      if (!run) throw notFound("Ingestion run");
      const mine = run.requestedBy === ctx.userId || (run.proposalId ? Boolean(await db.expansionProposal.findFirst({ where: { id: run.proposalId, createdByUserId: ctx.userId }, select: { id: true } })) : false);
      if (!mine) throw notFound("Ingestion run");
      return run;
    },
  }),
  tool({
    name: "atlas_estimate_expansion",
    description: "Estimate an expansion scope (channels, videos, quota units, search calls — all estimates) and check whether it is redundant with existing data or proposals. Creates nothing.",
    access: "read",
    input: z.object({ scope: ExpansionScopeSchema }).strict(),
    async run(i, ctx) {
      const scope = normalizeScope(i.scope);
      return { scope, scopeHash: scopeHash(scope), estimate: { ...estimate(scope), isEstimate: true }, redundancy: await redundancy(scope, ctx.userId) };
    },
  }),
  tool({
    name: "atlas_create_expansion_proposal",
    description: "Submit a bounded expansion proposal for the user to review. It stays PENDING until the user approves it in Atlas; you cannot approve it. Returns the proposal and a link to review it.",
    access: "propose",
    input: CreateProposalBody.strict(),
    async run(i, ctx) {
      const actor = agentActor(ctx);
      const p = await createProposal({ scope: i.scope, reason: i.reason, coverageGap: i.coverageGap, title: i.title }, actor);
      return { proposal: toDTO(p, actor), reviewUrl: `/data?proposal=${p.id}`, note: "Pending user approval in Atlas. Nothing runs until the user approves this exact scope." };
    },
  }),
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
export const toolByName = (name: string) => BY_NAME.get(name);

/** Validate untrusted input, enforce scope + read-only, run. */
export async function runTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<unknown> {
  const t = toolByName(name);
  if (!t) throw notFound(`Tool ${name}`);
  if (!ctx.scopes.includes(t.access)) throw new AppError("FORBIDDEN", `This agent token lacks the "${t.access}" scope required by ${name}`);
  const input = t.input.parse(rawInput ?? {});
  return t.access === "read" ? readOnly(`agent:${name}`, () => t.run(input, ctx)) : t.run(input, ctx);
}
