/**
 * Expansion governance: proposals → explicit single-use human approval → dispatch → per-job authorization.
 *
 * Invariants (enforced here, re-checked by queue producers and by the executing ingestion services):
 *  • A proposal's scope is immutable; its hash is recomputed on approval and on every job.
 *  • Approval: session user only (agents/Claude never), the proposal's creator — or an ADMIN for SYSTEM proposals —
 *    presenting the exact scopeHash they reviewed; PENDING → APPROVED happens once (row lock + status check).
 *  • Jobs run only while the proposal is RUNNING, only if their ID was registered on it, only before the execution
 *    deadline, and only against targets inside the scope. Rejected/expired/cancelled/completed proposals execute nothing.
 *  • Mandatory deletion (compliance, revocation, account deletion) never goes through here.
 */
import { createHash } from "node:crypto";
import { db, type Prisma, type ExpansionProposal, type ProposalSource } from "@/server/db";
import { env } from "@/server/env";
import { AppError, notFound } from "@/server/errors";
import { enqueueExpansion, expansionJobId, type ExpansionAuth, type ExpansionQueue, type Lane } from "@/server/jobs";
import { log } from "@/server/logger";
import { costOf, assertPolicy } from "@/server/youtube";
import { publish } from "@/server/services/realtime";
import { ExpansionScope, type ProposalDTO, type ProposalEstimate } from "@/shared/contracts/expansion";

export type { ExpansionScope } from "@/shared/contracts/expansion";

// ── Actors ─────────────────────────────────────────────────────────────────

export type Actor =
  /** A signed-in human using a browser session. The only actor that can approve. */
  | { kind: "user"; userId: string; role: "USER" | "ADMIN" }
  /** An AI agent acting for a user (e.g. Claude). May inspect and propose, never approve. */
  | { kind: "agent"; userId: string }
  /** Atlas schedulers (sync due, statistics, compliance refresh). Proposals need an ADMIN's approval. */
  | { kind: "system" }
  /** Local CLI operator (seed). May approve only fictional fixture-mode data. */
  | { kind: "cli"; userId: string };

/** Browser-session user → approving-capable actor. (Agent tokens, when added, must map to `kind: "agent"`.) */
export const userActor = (u: { id: string; role: "USER" | "ADMIN" }): Actor => ({ kind: "user", userId: u.id, role: u.role });

const SOURCE: Record<Actor["kind"], ProposalSource> = { user: "USER", agent: "CLAUDE", system: "SYSTEM", cli: "CLI" };

// ── Scope canonicalization ─────────────────────────────────────────────────

const sortUnique = (a: string[]) => [...new Set(a)].sort();

/** Parse + canonicalize (defaults applied, id lists sorted/deduped) so equal scopes hash equally. */
export function normalizeScope(input: unknown): ExpansionScope {
  const s = ExpansionScope.parse(input);
  switch (s.kind) {
    case "ADD_CHANNELS": {
      const by = new Map<string, string[]>();
      for (const c of s.channels) by.set(c.youtubeId, sortUnique([...(by.get(c.youtubeId) ?? []), ...c.aliases]));
      return { ...s, channels: [...by].sort(([a], [b]) => a.localeCompare(b)).map(([youtubeId, aliases]) => ({ youtubeId, aliases })) };
    }
    case "DISCOVER_CHANNELS":
      return { ...s, queries: sortUnique(s.queries.map((q) => q.trim())) };
    case "SYNC_UPLOADS":
      return { ...s, channelYoutubeIds: sortUnique(s.channelYoutubeIds) };
    case "REFRESH_METADATA":
      return { ...s, channelYoutubeIds: sortUnique(s.channelYoutubeIds), videoYoutubeIds: sortUnique(s.videoYoutubeIds) };
    default:
      return s;
  }
}

function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export function scopeHash(scope: ExpansionScope): string {
  return createHash("sha256").update(canonicalJson(normalizeScope(scope))).digest("hex");
}

// ── Estimates (all unit prices from youtube/costs.ts) ──────────────────────

const pages = (n: number) => Math.ceil(n / 50);

export function estimate(scope: ExpansionScope): ProposalEstimate {
  const b: ProposalEstimate["breakdown"] = [];
  const add = (label: string, method: Parameters<typeof costOf>[0], calls: number) => {
    const c = costOf(method);
    if (calls > 0) b.push({ label: `${label} (${calls} × ${method})`, units: c.units * calls, bucket: c.bucket });
  };
  let channels = 0;
  let videos = 0;
  let uncertainty: string | null = null;
  switch (scope.kind) {
    case "ADD_CHANNELS": {
      const n = scope.channels.length;
      channels = n;
      videos = n * scope.maxVideosPerChannel;
      add("channel details", "channels.list", n);
      add("uploads pages", "playlistItems.list", n * pages(scope.maxVideosPerChannel));
      add("video metadata", "videos.list", n * pages(scope.maxVideosPerChannel));
      add("featured channels", "channelSections.list", n);
      uncertainty = "Video counts are upper bounds: channels with fewer uploads cost less. Owner captions (if eligible) add 250 units per video.";
      break;
    }
    case "DISCOVER_CHANNELS": {
      const candidates = scope.queries.length * scope.maxCandidatesPerQuery;
      channels = scope.maxChannelsToAdd;
      videos = scope.maxChannelsToAdd * scope.maxVideosPerChannel;
      add("searches", "search.list", scope.queries.length);
      add("candidate enrichment", "channels.list", pages(candidates));
      add("ingest of added channels", "channels.list", channels);
      add("uploads pages", "playlistItems.list", channels * pages(scope.maxVideosPerChannel));
      add("video metadata", "videos.list", channels * pages(scope.maxVideosPerChannel));
      add("featured channels", "channelSections.list", channels);
      uncertainty = `Search results are not known in advance. At most ${scope.maxChannelsToAdd} new channel(s) are added (candidates already in Atlas are skipped); the operation stops at that bound.`;
      break;
    }
    case "BACKFILL_HISTORY": {
      channels = 0;
      videos = Math.min(scope.maxVideos, scope.maxPages * 50);
      add("channel details", "channels.list", 1);
      add("uploads pages", "playlistItems.list", scope.maxPages);
      add("video metadata", "videos.list", Math.min(scope.maxPages, pages(scope.maxVideos)));
      uncertainty = "Continues from the saved checkpoint; stops at the page/video bound or the end of the channel's history, whichever comes first.";
      break;
    }
    case "SYNC_UPLOADS": {
      const n = scope.channelYoutubeIds.length;
      videos = n * scope.maxNewVideosPerChannel;
      add("channel details", "channels.list", pages(n));
      add("newest uploads page", "playlistItems.list", n);
      add("new video metadata", "videos.list", n);
      uncertainty = `Usually ~3 units per channel: each sync stops at the first already-known upload. Worst case ${n * 2 * pages(scope.maxNewVideosPerChannel) + pages(n)} units if every channel has ${scope.maxNewVideosPerChannel} new uploads.`;
      break;
    }
    case "REFRESH_METADATA": {
      add("channel refresh", "channels.list", pages(scope.channelYoutubeIds.length));
      add("video refresh", "videos.list", pages(scope.videoYoutubeIds.length));
      uncertainty = "Refresh updates existing records only; it never adds channels or videos. Records YouTube no longer returns are deleted.";
      break;
    }
  }
  return {
    channels,
    videos,
    quotaUnits: b.filter((x) => x.bucket === "general").reduce((a, x) => a + x.units, 0),
    searchCalls: b.filter((x) => x.bucket === "search").reduce((a, x) => a + x.units, 0),
    uncertainty,
    breakdown: b,
  };
}

function targetsOf(scope: ExpansionScope): { targetType: string; targetIds: string[] } {
  switch (scope.kind) {
    case "ADD_CHANNELS":
      return { targetType: "channel", targetIds: scope.channels.map((c) => c.youtubeId) };
    case "DISCOVER_CHANNELS":
      return { targetType: scope.nicheId ? "niche" : "query", targetIds: scope.nicheId ? [scope.nicheId] : scope.queries };
    case "BACKFILL_HISTORY":
      return { targetType: "channel", targetIds: [scope.channelYoutubeId] };
    case "SYNC_UPLOADS":
      return { targetType: "channel", targetIds: scope.channelYoutubeIds };
    case "REFRESH_METADATA":
      return { targetType: scope.videoYoutubeIds.length ? "video" : "channel", targetIds: [...scope.channelYoutubeIds, ...scope.videoYoutubeIds].slice(0, 2_000) };
  }
}

function defaultTitle(scope: ExpansionScope): string {
  switch (scope.kind) {
    case "ADD_CHANNELS":
      return scope.channels.length === 1 ? `Add channel ${scope.channels[0]!.youtubeId}` : `Add ${scope.channels.length} channels`;
    case "DISCOVER_CHANNELS":
      return `Discover up to ${scope.maxChannelsToAdd} channel(s) for “${scope.queries.join(" | ").slice(0, 80)}”`;
    case "BACKFILL_HISTORY":
      return `Collect up to ${scope.maxVideos} older uploads of ${scope.channelYoutubeId}`;
    case "SYNC_UPLOADS":
      return `Check ${scope.channelYoutubeIds.length} channel(s) for new uploads`;
    case "REFRESH_METADATA":
      return `Refresh ${scope.fields === "statistics" ? "statistics" : "metadata"} of ${scope.channelYoutubeIds.length} channel(s) / ${scope.videoYoutubeIds.length} video(s)`;
  }
}

// ── Target validation (no API calls) ───────────────────────────────────────

async function validateTargets(scope: ExpansionScope) {
  const missing = (want: string[], have: string[]) => want.filter((x) => !new Set(have).has(x));
  switch (scope.kind) {
    case "ADD_CHANNELS": {
      const existing = await db.channel.findMany({ where: { youtubeId: { in: scope.channels.map((c) => c.youtubeId) } }, select: { youtubeId: true } });
      if (existing.length === scope.channels.length) throw new AppError("CONFLICT", "Every channel in this proposal is already in the atlas", { existing: existing.map((e) => e.youtubeId) });
      if (existing.length) throw new AppError("VALIDATION_ERROR", "Some channels are already in the atlas; remove them from the proposal", { existing: existing.map((e) => e.youtubeId) });
      return;
    }
    case "BACKFILL_HISTORY": {
      const c = await db.channel.findUnique({ where: { youtubeId: scope.channelYoutubeId }, select: { history: { select: { state: true, nextPageToken: true } } } });
      if (!c) throw notFound("Channel");
      if (c.history && !c.history.nextPageToken && ["COMPLETE_TO_SOURCE_LIMIT", "SOURCE_UNAVAILABLE"].includes(c.history.state)) {
        throw new AppError("CONFLICT", "This channel's upload history is already complete");
      }
      return;
    }
    case "SYNC_UPLOADS": {
      const have = await db.channel.findMany({ where: { youtubeId: { in: scope.channelYoutubeIds } }, select: { youtubeId: true } });
      const m = missing(scope.channelYoutubeIds, have.map((h) => h.youtubeId));
      if (m.length) throw new AppError("VALIDATION_ERROR", "Sync only applies to channels already in the atlas", { missing: m.slice(0, 20) });
      return;
    }
    case "REFRESH_METADATA": {
      if (!scope.channelYoutubeIds.length && !scope.videoYoutubeIds.length) throw new AppError("VALIDATION_ERROR", "Nothing to refresh");
      const ch = await db.channel.count({ where: { youtubeId: { in: scope.channelYoutubeIds } } });
      const vs = await db.video.count({ where: { youtubeId: { in: scope.videoYoutubeIds } } });
      if (ch !== scope.channelYoutubeIds.length || vs !== scope.videoYoutubeIds.length) throw new AppError("VALIDATION_ERROR", "Refresh only applies to records already in the atlas");
      return;
    }
    case "DISCOVER_CHANNELS":
      if (scope.nicheId && !(await db.niche.findFirst({ where: { OR: [{ id: scope.nicheId }, { slug: scope.nicheId }] }, select: { id: true } }))) throw notFound("Niche");
      return;
  }
}

// ── Create ─────────────────────────────────────────────────────────────────

export interface CreateProposalInput {
  scope: unknown;
  reason: string;
  coverageGap?: string;
  title?: string;
  /** SYSTEM compliance proposals expire before the earliest retention deadline they protect. */
  expiresAt?: Date;
}

const MAX_PENDING_PER_USER = 50;
const HOUR = 3_600_000;

export async function createProposal(input: CreateProposalInput, actor: Actor): Promise<ExpansionProposal> {
  assertPolicy("live-collection");
  const scope = normalizeScope(input.scope);
  if (scope.kind === "DISCOVER_CHANNELS") assertPolicy("live-collection");
  await validateTargets(scope);
  const hash = scopeHash(scope);
  const createdByUserId = actor.kind === "system" ? null : actor.userId;
  // Identical pending proposal from the same requester → return it (idempotent "propose").
  const dup = await db.expansionProposal.findFirst({ where: { scopeHash: hash, status: "PENDING", createdByUserId, source: SOURCE[actor.kind], expiresAt: { gt: new Date() } } });
  if (dup) return dup;
  if (createdByUserId && (await db.expansionProposal.count({ where: { createdByUserId, status: "PENDING" } })) >= MAX_PENDING_PER_USER) {
    throw new AppError("RATE_LIMITED", `You have ${MAX_PENDING_PER_USER} pending proposals; approve, reject or let some expire first`);
  }
  const est = estimate(scope);
  const { targetType, targetIds } = targetsOf(scope);
  const p = await db.expansionProposal.create({
    data: {
      createdByUserId,
      source: SOURCE[actor.kind],
      kind: scope.kind,
      targetType,
      targetIds,
      scope: scope as unknown as Prisma.InputJsonValue,
      scopeHash: hash,
      title: (input.title || defaultTitle(scope)).slice(0, 200),
      reason: input.reason.slice(0, 2_000),
      coverageGap: input.coverageGap?.slice(0, 2_000),
      uncertainty: est.uncertainty,
      estimatedChannels: est.channels,
      estimatedVideos: est.videos,
      estimatedQuota: est.quotaUnits,
      estimatedSearchCalls: est.searchCalls,
      expiresAt: input.expiresAt ?? new Date(Date.now() + env.PROPOSAL_TTL_HOURS * HOUR),
      actualResults: { breakdown: est.breakdown } as Prisma.InputJsonValue,
    },
  });
  log().info({ proposalId: p.id, kind: p.kind, source: p.source, scopeHash: hash, estimate: { q: est.quotaUnits, s: est.searchCalls } }, "expansion proposed");
  await notify(p, "proposal.created");
  return p;
}

// ── Decide ─────────────────────────────────────────────────────────────────

function canDecide(p: Pick<ExpansionProposal, "source" | "createdByUserId">, actor: Actor): boolean {
  if (actor.kind === "cli") return env.YOUTUBE_MODE === "fixture" && (p.source === "CLI" || p.createdByUserId === actor.userId);
  if (actor.kind !== "user") return false; // agents and the system can never approve
  if (p.source === "SYSTEM") return actor.role === "ADMIN";
  return p.createdByUserId === actor.userId;
}

async function lockPending(tx: Prisma.TransactionClient, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "ExpansionProposal" WHERE id = ${id} FOR UPDATE`;
  if (!rows.length) throw notFound("Proposal");
  return tx.expansionProposal.findUniqueOrThrow({ where: { id } });
}

export async function approveProposal(id: string, actor: Actor, presentedHash: string, note?: string): Promise<ExpansionProposal> {
  if (actor.kind === "agent" || actor.kind === "system") throw new AppError("FORBIDDEN", "Only a signed-in user can approve proposals in Atlas");
  assertPolicy("live-collection");
  const approverId = actor.userId;
  const approved = await db.$transaction(async (tx) => {
    const p = await lockPending(tx, id);
    if (!canDecide(p, actor)) throw notFound("Proposal"); // don't reveal other users' proposals
    if (p.status !== "PENDING") throw new AppError("CONFLICT", `Proposal is ${p.status.toLowerCase()}; approvals are single-use`);
    if (p.expiresAt.getTime() <= Date.now()) return tx.expansionProposal.update({ where: { id }, data: { status: "EXPIRED" } });
    if (presentedHash !== p.scopeHash) throw new AppError("CONFLICT", "The scope you reviewed no longer matches this proposal");
    if (scopeHash(p.scope as ExpansionScope) !== p.scopeHash) throw new AppError("CONFLICT", "Proposal scope integrity check failed");
    const now = new Date();
    return tx.expansionProposal.update({
      where: { id },
      data: { status: "APPROVED", approvedByUserId: approverId, approvedAt: now, decidedByUserId: approverId, decidedAt: now, decisionNote: note, executionDeadline: new Date(now.getTime() + env.PROPOSAL_EXECUTION_DAYS * 24 * HOUR) },
    });
  });
  if (approved.status === "EXPIRED") throw new AppError("CONFLICT", "Proposal expired; create a new one");
  log().info({ proposalId: id, approvedBy: approverId, scopeHash: approved.scopeHash }, "expansion approved");
  return dispatch(approved);
}

export async function rejectProposal(id: string, actor: Actor, presentedHash: string, note?: string) {
  if (actor.kind === "agent") throw new AppError("FORBIDDEN", "Agents cannot decide proposals");
  return db.$transaction(async (tx) => {
    const p = await lockPending(tx, id);
    if (!canDecide(p, actor)) throw notFound("Proposal");
    if (p.status !== "PENDING") throw new AppError("CONFLICT", `Proposal is ${p.status.toLowerCase()}`);
    if (presentedHash !== p.scopeHash) throw new AppError("CONFLICT", "The scope you reviewed no longer matches this proposal");
    const actorId = actor.kind === "system" ? null : actor.userId;
    return tx.expansionProposal.update({ where: { id }, data: { status: "REJECTED", decidedByUserId: actorId, decidedAt: new Date(), decisionNote: note } });
  });
}

/** Stops a pending or running proposal. Running jobs observe the status at their next page/batch boundary. */
export async function cancelProposal(id: string, actor: Actor) {
  const p = await db.expansionProposal.findUnique({ where: { id } });
  if (!p) throw notFound("Proposal");
  const mayCancel = canDecide(p, actor) || (actor.kind === "user" && actor.role === "ADMIN");
  if (!mayCancel) throw notFound("Proposal");
  const r = await db.expansionProposal.updateMany({ where: { id, status: { in: ["PENDING", "APPROVED", "RUNNING"] } }, data: { status: "CANCELLED", finishedAt: new Date(), decidedAt: p.decidedAt ?? new Date() } });
  if (!r.count) throw new AppError("CONFLICT", `Proposal is ${p.status.toLowerCase()}`);
  const out = await db.expansionProposal.findUniqueOrThrow({ where: { id } });
  await notify(out, "proposal.updated");
  return out;
}

// ── Dispatch ───────────────────────────────────────────────────────────────

interface RootJob {
  queue: ExpansionQueue;
  jobId: string;
  data: { auth: ExpansionAuth; lane: Lane; requestedBy?: string } & Record<string, unknown>;
}

function rootJobs(p: ExpansionProposal, scope: ExpansionScope): RootJob[] {
  const auth: ExpansionAuth = { proposalId: p.id, scopeHash: p.scopeHash };
  const lane: Lane = p.source === "SYSTEM" ? "background" : "interactive";
  const base = { auth, lane, requestedBy: p.createdByUserId ?? undefined };
  switch (scope.kind) {
    case "ADD_CHANNELS":
      return scope.channels.map((c) => ({ queue: "ingest-channel" as const, jobId: expansionJobId(p.id, `ingest-${c.youtubeId}`), data: { ...base, youtubeId: c.youtubeId, aliases: c.aliases } }));
    case "DISCOVER_CHANNELS":
      return [{ queue: "discover-channels", jobId: expansionJobId(p.id, "discover"), data: base }];
    case "BACKFILL_HISTORY":
      return [{ queue: "backfill-history", jobId: expansionJobId(p.id, "backfill-0"), data: { ...base, youtubeId: scope.channelYoutubeId, slice: 0 } }];
    case "SYNC_UPLOADS":
      return scope.channelYoutubeIds.map((yt) => ({ queue: "sync-channel" as const, jobId: expansionJobId(p.id, `sync-${yt}`), data: { ...base, youtubeId: yt } }));
    case "REFRESH_METADATA": {
      const jobs: RootJob[] = [];
      for (let i = 0; i < scope.channelYoutubeIds.length; i += 50) jobs.push({ queue: "refresh-metadata", jobId: expansionJobId(p.id, `refresh-c${i / 50}`), data: { ...base, channelYoutubeIds: scope.channelYoutubeIds.slice(i, i + 50), videoYoutubeIds: [] } });
      for (let i = 0; i < scope.videoYoutubeIds.length; i += 50) jobs.push({ queue: "refresh-metadata", jobId: expansionJobId(p.id, `refresh-v${i / 50}`), data: { ...base, channelYoutubeIds: [], videoYoutubeIds: scope.videoYoutubeIds.slice(i, i + 50) } });
      return jobs;
    }
  }
}

async function dispatch(p: ExpansionProposal): Promise<ExpansionProposal> {
  const scope = normalizeScope(p.scope);
  const jobs = rootJobs(p, scope);
  // APPROVED → RUNNING exactly once, registering every root job before any is enqueued.
  const r = await db.expansionProposal.updateMany({ where: { id: p.id, status: "APPROVED" }, data: { status: "RUNNING", startedAt: new Date(), jobIds: jobs.map((j) => j.jobId) } });
  if (!r.count) return db.expansionProposal.findUniqueOrThrow({ where: { id: p.id } });
  try {
    for (const j of jobs) await enqueueExpansion(j.queue, j.data as never, j.jobId);
  } catch (e) {
    await db.expansionProposal.update({ where: { id: p.id }, data: { status: "FAILED", error: `dispatch failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500), finishedAt: new Date() } });
    throw e;
  }
  const out = await db.expansionProposal.findUniqueOrThrow({ where: { id: p.id } });
  await notify(out, "proposal.updated");
  return out;
}

// ── Worker-side authorization ──────────────────────────────────────────────

export class ApprovalError extends AppError {
  constructor(message: string) {
    super("FORBIDDEN", message, { approval: true });
  }
}

export interface AuthorizedJob<S extends ExpansionScope = ExpansionScope> {
  proposal: ExpansionProposal;
  scope: S;
  auth: ExpansionAuth;
  jobId: string;
}

/**
 * Called by every executing service before it persists anything (and again at page/batch boundaries via
 * `assertStillRunning`). Throws ApprovalError (non-retryable) unless the job is authorized for `target`.
 */
export async function authorizeJob<K extends ExpansionScope["kind"]>(
  auth: ExpansionAuth | undefined,
  jobId: string | undefined,
  kind: K | K[],
  target?: { channelYoutubeId?: string; channelYoutubeIds?: string[]; videoYoutubeIds?: string[] },
): Promise<AuthorizedJob<Extract<ExpansionScope, { kind: K }>>> {
  if (!auth?.proposalId || !auth.scopeHash || !jobId) throw new ApprovalError("No approved proposal accompanies this job");
  const p = await db.expansionProposal.findUnique({ where: { id: auth.proposalId } });
  if (!p) throw new ApprovalError("Proposal not found");
  if (p.status !== "RUNNING") throw new ApprovalError(`Proposal is ${p.status.toLowerCase()}`);
  if (p.scopeHash !== auth.scopeHash) throw new ApprovalError("Scope hash mismatch");
  const scope = normalizeScope(p.scope);
  if (scopeHash(scope) !== p.scopeHash) throw new ApprovalError("Stored scope failed its integrity check");
  const kinds = Array.isArray(kind) ? kind : [kind];
  if (!kinds.includes(scope.kind as K)) throw new ApprovalError(`Proposal kind ${scope.kind} does not authorize this job`);
  if (!p.jobIds.includes(jobId)) throw new ApprovalError("Job is not registered on the proposal");
  if (p.executionDeadline && p.executionDeadline.getTime() < Date.now()) throw new ApprovalError("Approval execution window has passed");
  if (target) {
    const allowed = channelSet(scope, p);
    const want = [...(target.channelYoutubeId ? [target.channelYoutubeId] : []), ...(target.channelYoutubeIds ?? [])];
    const bad = want.filter((c) => !allowed.has(c));
    if (bad.length) throw new ApprovalError(`Channel(s) outside the approved scope: ${bad.slice(0, 5).join(", ")}`);
    if (target.videoYoutubeIds?.length) {
      if (scope.kind !== "REFRESH_METADATA") throw new ApprovalError("Only refresh proposals target individual videos");
      const vs = new Set(scope.videoYoutubeIds);
      if (target.videoYoutubeIds.some((v) => !vs.has(v))) throw new ApprovalError("Video(s) outside the approved scope");
    }
  }
  return { proposal: p, scope: scope as Extract<ExpansionScope, { kind: K }>, auth, jobId };
}

/** Channels a proposal may touch. For discovery: only the candidates the discovery job selected (≤ maxChannelsToAdd). */
export function channelSet(scope: ExpansionScope, p: Pick<ExpansionProposal, "actualResults">): Set<string> {
  switch (scope.kind) {
    case "ADD_CHANNELS":
      return new Set(scope.channels.map((c) => c.youtubeId));
    case "DISCOVER_CHANNELS": {
      const sel = ((p.actualResults ?? {}) as { selected?: string[] }).selected ?? [];
      return new Set(sel.slice(0, scope.maxChannelsToAdd));
    }
    case "BACKFILL_HISTORY":
      return new Set([scope.channelYoutubeId]);
    case "SYNC_UPLOADS":
      return new Set(scope.channelYoutubeIds);
    case "REFRESH_METADATA":
      return new Set(scope.channelYoutubeIds);
  }
}

/** Cheap re-check between pages/batches so cancellation stops work promptly. */
export async function assertStillRunning(proposalId: string) {
  const p = await db.expansionProposal.findUnique({ where: { id: proposalId }, select: { status: true, executionDeadline: true } });
  if (!p || p.status !== "RUNNING") throw new ApprovalError(`Proposal is ${p?.status.toLowerCase() ?? "missing"}`);
  if (p.executionDeadline && p.executionDeadline.getTime() < Date.now()) throw new ApprovalError("Approval execution window has passed");
}

/** Register follow-up jobs (discovery children, backfill continuations, transcripts) on a RUNNING proposal. */
export async function registerChildJobs(proposalId: string, jobIds: string[]) {
  if (!jobIds.length) return;
  const n = await db.$executeRaw`
    UPDATE "ExpansionProposal" SET "jobIds" = ARRAY(SELECT DISTINCT unnest("jobIds" || ${jobIds}::text[])), "updatedAt" = now()
    WHERE id = ${proposalId} AND status = 'RUNNING'`;
  if (!n) throw new ApprovalError("Proposal is no longer running; follow-up work was not registered");
}

/** Discovery records which candidates it selected; later children are authorized against exactly this set. */
export async function recordDiscoverySelection(proposalId: string, maxChannelsToAdd: number, selected: string[], candidates: unknown[]) {
  if (selected.length > maxChannelsToAdd) throw new ApprovalError("Discovery selected more channels than approved");
  const n = await db.$executeRaw`
    UPDATE "ExpansionProposal" SET "actualResults" = "actualResults" || ${JSON.stringify({ selected, candidates })}::jsonb, "updatedAt" = now()
    WHERE id = ${proposalId} AND status = 'RUNNING' AND NOT ("actualResults" ? 'selected')`;
  if (!n) throw new ApprovalError("Discovery selection already recorded for this proposal (replay refused)");
}

/**
 * Record a job outcome (idempotent per job ID). When every registered job has finished, the proposal becomes
 * COMPLETED (or FAILED if any job failed permanently).
 */
export async function completeJob(proposalId: string, jobId: string, outcome: { ok: boolean; units?: number; searches?: number; result?: unknown; error?: string }) {
  const finished = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ExpansionProposal" WHERE id = ${proposalId} FOR UPDATE`;
    const p = await tx.expansionProposal.findUnique({ where: { id: proposalId } });
    if (!p || p.doneJobIds.includes(jobId) || p.failedJobIds.includes(jobId)) return null;
    const results = (p.actualResults ?? {}) as Record<string, unknown>;
    const jobs = { ...((results.jobs as Record<string, unknown>) ?? {}), [jobId]: outcome.ok ? (outcome.result ?? { ok: true }) : { error: outcome.error } };
    const done = outcome.ok ? [...p.doneJobIds, jobId] : p.doneJobIds;
    const failed = outcome.ok ? p.failedJobIds : [...p.failedJobIds, jobId];
    const allDone = p.status === "RUNNING" && p.jobIds.every((j) => done.includes(j) || failed.includes(j));
    return tx.expansionProposal.update({
      where: { id: proposalId },
      data: {
        doneJobIds: done,
        failedJobIds: failed,
        actualQuota: { increment: outcome.units ?? 0 },
        actualSearchCalls: { increment: outcome.searches ?? 0 },
        actualResults: { ...results, jobs } as Prisma.InputJsonValue,
        ...(allDone ? { status: failed.length ? "FAILED" : "COMPLETED", finishedAt: new Date(), error: failed.length ? `${failed.length} job(s) failed` : null } : {}),
      },
    });
  });
  if (finished) await notify(finished, "proposal.updated");
  return finished;
}

/** Periodic: PENDING past expiry → EXPIRED; RUNNING past the execution deadline → FAILED. */
export async function expireProposals(now = new Date()) {
  const expired = await db.expansionProposal.updateMany({ where: { status: "PENDING", expiresAt: { lte: now } }, data: { status: "EXPIRED" } });
  const stale = await db.expansionProposal.updateMany({ where: { status: { in: ["RUNNING", "APPROVED"] }, executionDeadline: { lt: now } }, data: { status: "FAILED", error: "execution deadline passed", finishedAt: now } });
  return { expired: expired.count, timedOut: stale.count };
}

// ── Reads ──────────────────────────────────────────────────────────────────

function visibleTo(actor: Actor): Prisma.ExpansionProposalWhereInput {
  if (actor.kind === "user" && actor.role === "ADMIN") return {};
  if (actor.kind === "system") return {};
  return { createdByUserId: actor.userId };
}

export async function getProposal(id: string, actor: Actor): Promise<ProposalDTO> {
  const p = await db.expansionProposal.findFirst({ where: { id, ...visibleTo(actor) } });
  if (!p) throw notFound("Proposal");
  return toDTO(p, actor);
}

export async function listProposals(actor: Actor, opts: { status?: string; limit: number }) {
  const status = opts.status === "active" ? { in: ["PENDING", "APPROVED", "RUNNING"] as const } : opts.status ? (opts.status as ExpansionProposal["status"]) : undefined;
  const rows = await db.expansionProposal.findMany({ where: { ...visibleTo(actor), ...(status ? { status: status as never } : {}) }, orderBy: { createdAt: "desc" }, take: opts.limit });
  return rows.map((p) => toDTO(p, actor));
}

export function toDTO(p: ExpansionProposal, actor: Actor): ProposalDTO {
  const results = { ...((p.actualResults ?? {}) as Record<string, unknown>) };
  return {
    id: p.id,
    kind: p.kind,
    source: p.source,
    status: p.status,
    title: p.title,
    reason: p.reason,
    coverageGap: p.coverageGap,
    uncertainty: p.uncertainty,
    targetType: p.targetType,
    targetIds: p.targetIds,
    scope: p.scope as ExpansionScope,
    scopeHash: p.scopeHash,
    estimate: { channels: p.estimatedChannels, videos: p.estimatedVideos, quotaUnits: p.estimatedQuota, searchCalls: p.estimatedSearchCalls, isEstimate: true },
    createdByUserId: p.createdByUserId,
    createdAt: p.createdAt.toISOString(),
    expiresAt: p.expiresAt.toISOString(),
    approvedByUserId: p.approvedByUserId,
    approvedAt: p.approvedAt?.toISOString() ?? null,
    decidedAt: p.decidedAt?.toISOString() ?? null,
    decisionNote: p.decisionNote,
    startedAt: p.startedAt?.toISOString() ?? null,
    finishedAt: p.finishedAt?.toISOString() ?? null,
    executionDeadline: p.executionDeadline?.toISOString() ?? null,
    jobs: { total: p.jobIds.length, done: p.doneJobIds.length, failed: p.failedJobIds.length },
    actual: { quotaUnits: p.actualQuota, searchCalls: p.actualSearchCalls, results },
    error: p.error,
    canDecide: p.status === "PENDING" && canDecide(p, actor),
  };
}

async function notify(p: ExpansionProposal, type: "proposal.created" | "proposal.updated") {
  const payload = { id: p.id, kind: p.kind, status: p.status, title: p.title };
  await publish({ type, scope: p.createdByUserId ? { userId: p.createdByUserId } : "global", payload }).catch(() => undefined);
}
