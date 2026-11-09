/**
 * YouTube collection engine. Every function that adds to or refreshes the corpus runs under an approved proposal and
 * calls `authorizeJob` before persisting anything (services/expansion). Efficient official-API path only:
 *
 *   channels.list → uploads playlist id → playlistItems.list (50/page, newest → oldest) → videos.list (≤ 50 ids)
 *   → normalize + coverage → canonical rows → transcripts (if a provider applies) → embed → topics → classify → graph
 *
 * `search.list` is used only by discovery. Upload history is collected page by page; each page's videos, coverage
 * and the history checkpoint commit in ONE transaction, so an interrupted job resumes at the first uncommitted page
 * without skipping or double-counting.
 */
import { db, type Prisma, type HistoryState, type SyncTier } from "@/server/db";
import { AppError } from "@/server/errors";
import { enqueue, enqueueExpansion, expansionJobId, type ExpansionAuth, type Lane } from "@/server/jobs";
import { log } from "@/server/logger";
import { youtube, withYouTubeContext, normalizeChannel, normalizeVideo, policyAllows, type YtChannel, type YtVideo } from "@/server/youtube";
import * as quota from "@/server/services/quota";
import { withLock } from "@/server/services/cache";
import { publish } from "@/server/services/realtime";
import { recordCoverage, recordCoverageError, type CoverageWrite } from "@/server/services/coverage";
import { transcriptCandidates, markTranscriptsUnavailable } from "@/server/services/transcripts";
import {
  authorizeJob,
  assertStillRunning,
  channelSet,
  createProposal,
  recordDiscoverySelection,
  registerChildJobs,
  type AuthorizedJob,
  type ExpansionScope,
} from "@/server/services/expansion";
import { reserveUserDiscovery, refundUserDiscovery } from "@/server/services/quota";
import { embedTexts } from "@/server/services/embeddings";
import { toVectorLiteral } from "@/server/db/vector";

export { parseKeywords } from "@/server/youtube";

// ── Run bookkeeping ────────────────────────────────────────────────────────

export interface JobControl {
  jobId: string;
  progress(pct: number, step: string, extra?: Record<string, unknown>): Promise<void>;
}

interface RunAcc {
  units: number;
  searches: number;
}

async function startRun(kind: string, targetId: string, a: AuthorizedJob, requestedBy?: string) {
  return db.ingestionRun.create({ data: { kind, targetId, status: "running", requestedBy, proposalId: a.proposal.id, jobId: a.jobId, scopeHash: a.auth.scopeHash }, select: { id: true } });
}

async function finishRun(id: string, acc: RunAcc, status: "completed" | "failed" | "skipped", stats: Record<string, unknown>, error?: string) {
  await db.ingestionRun.update({
    where: { id },
    data: { status, unitsUsed: acc.units, searchCalls: acc.searches, finishedAt: new Date(), stats: stats as Prisma.InputJsonValue, error },
  });
}

function costTracker(acc: RunAcc) {
  return (_m: string, bucket: string, units: number) => {
    if (bucket === "search") acc.searches += units;
    else acc.units += units;
  };
}

export async function emitJobEvent(type: "job.progress" | "job.completed" | "job.failed", payload: Record<string, unknown> & { jobId: string }, requestedBy?: string) {
  // User-initiated jobs go to that user's channel only (no duplicate delivery); background jobs are global.
  await publish({ type, scope: requestedBy ? { userId: requestedBy } : "global", payload });
}

/** Common job envelope passed from the worker. */
export interface JobInput {
  auth: ExpansionAuth;
  lane: Lane;
  requestedBy?: string;
}

// ── Upserts ────────────────────────────────────────────────────────────────

const TX = { timeout: 60_000, maxWait: 10_000 };

/** Upsert a channel from a channels.list item. Partial responses never erase stored values (normalize.ts). */
async function upsertChannel(c: YtChannel, aliases: string[], at: Date, tx: Prisma.TransactionClient = db) {
  const { data, coverage } = normalizeChannel(c);
  const existing = await tx.channel.findUnique({ where: { youtubeId: c.id }, select: { id: true, etag: true } });
  // Handle uniqueness: if another (stale) row holds this handle, release it.
  if (typeof data.handle === "string") await tx.channel.updateMany({ where: { handle: data.handle, NOT: { youtubeId: c.id } }, data: { handle: null } });
  const full = Boolean(c.snippet && c.statistics && c.contentDetails);
  const fresh = { ...(full ? { lastRefreshedAt: at } : {}), ...(c.statistics ? { lastStatsAt: at } : {}), isAvailable: true };
  let id: string;
  let changed = true;
  if (existing && existing.etag && existing.etag === data.etag) {
    changed = false;
    id = existing.id;
    await tx.channel.update({ where: { id }, data: fresh });
  } else if (existing) {
    id = existing.id;
    await tx.channel.update({ where: { id }, data: { ...(data as Prisma.ChannelUpdateInput), ...fresh } });
  } else {
    id = (await tx.channel.create({ data: { title: c.id, ...(data as Omit<Prisma.ChannelCreateInput, "title">), ...fresh } as Prisma.ChannelCreateInput, select: { id: true } })).id;
  }
  const allAliases = new Set([`id:${c.id}`, ...aliases]);
  if (typeof data.handle === "string") allAliases.add(`handle:${data.handle}`);
  const custom = data.customUrl as string | null | undefined;
  if (custom && !custom.startsWith("@")) allAliases.add(`custom:${custom.toLowerCase()}`);
  for (const value of allAliases) {
    await tx.channelAlias.upsert({ where: { value }, create: { channelId: id, kind: value.split(":")[0]!, value }, update: { channelId: id } });
  }
  await recordCoverage([{ channelId: id, groups: coverage }], "youtube:channels.list", at, tx);
  return { id, created: !existing, changed };
}

interface VideoWriteStats {
  created: string[];
  updated: string[];
  unchanged: number;
  /** Requested IDs videos.list did not return (private/deleted/unavailable). */
  notReturned: string[];
  /** Returned without the snippet part, so a new record could not be created. */
  incomplete: string[];
  publishedAts: Date[];
}

const emptyStats = (): VideoWriteStats => ({ created: [], updated: [], unchanged: 0, notReturned: [], incomplete: [], publishedAts: [] });

async function upsertVideos(requested: string[], videos: YtVideo[], channelId: string, at: Date, tx: Prisma.TransactionClient): Promise<VideoWriteStats> {
  const stats = emptyStats();
  const returned = new Set(videos.map((v) => v.id));
  stats.notReturned = requested.filter((id) => !returned.has(id));
  if (!videos.length) return stats;
  const existing = await tx.video.findMany({ where: { youtubeId: { in: videos.map((v) => v.id) } }, select: { id: true, youtubeId: true, etag: true, channelId: true } });
  const byYt = new Map(existing.map((e) => [e.youtubeId, e]));
  const cov: CoverageWrite[] = [];
  for (const v of videos) {
    const prev = byYt.get(v.id);
    const { data, coverage } = normalizeVideo(v);
    const full = Boolean(v.snippet && v.contentDetails && v.statistics);
    const fresh = { ...(full ? { lastRefreshedAt: at } : {}), ...(v.statistics ? { lastStatsAt: at } : {}), isAvailable: true };
    if (v.snippet?.publishedAt) stats.publishedAts.push(new Date(v.snippet.publishedAt));
    let id: string;
    if (!prev) {
      if (!v.snippet) {
        stats.incomplete.push(v.id); // cannot create a record without title/publishedAt; retried on the next collection
        continue;
      }
      id = (await tx.video.create({ data: { ...(data as Omit<Prisma.VideoUncheckedCreateInput, "channelId">), channelId, ...fresh } as Prisma.VideoUncheckedCreateInput, select: { id: true } })).id;
      stats.created.push(id);
    } else if (prev.etag && prev.etag === data.etag && prev.channelId === channelId) {
      id = prev.id;
      stats.unchanged++;
      await tx.video.update({ where: { id }, data: fresh });
    } else {
      id = prev.id;
      await tx.video.update({ where: { id }, data: { ...(data as Prisma.VideoUncheckedUpdateInput), channelId, ...fresh } });
      stats.updated.push(id);
    }
    cov.push({ videoId: id, groups: coverage });
  }
  await recordCoverage(cov, "youtube:videos.list", at, tx);
  return stats;
}

// ── Downstream fan-out (existing Atlas pipeline) ───────────────────────────

/**
 * New/changed videos → transcripts (registered under the same approval) → embeddings + topics; channel embedding →
 * classification; graph nodes marked dirty. Transcript problems never fail metadata collection.
 */
async function fanOut(channel: { id: string; youtubeId: string }, changedVideoIds: string[], channelChanged: boolean, a: AuthorizedJob, includeTranscripts: boolean) {
  if (changedVideoIds.length) {
    const vids = await db.video.findMany({ where: { id: { in: changedVideoIds } }, select: { id: true, youtubeId: true, captionFlag: true, hasTranscript: true, transcriptStatus: true } });
    const jobs: { videoId: string; provider: string; connectionId?: string; jobId: string }[] = [];
    const noProvider: { id: string; captionFlag: boolean | null }[] = [];
    for (const v of vids) {
      if (v.hasTranscript || !includeTranscripts) continue;
      const cands = await transcriptCandidates({ id: v.id, youtubeId: v.youtubeId, channelYoutubeId: channel.youtubeId, captionFlag: v.captionFlag });
      if (!cands.length) {
        if (v.transcriptStatus === "NOT_CHECKED") noProvider.push(v);
        continue;
      }
      for (const c of cands) jobs.push({ videoId: v.id, provider: c.provider, connectionId: c.connectionId, jobId: expansionJobId(a.proposal.id, `tx-${v.id}-${c.provider}${c.connectionId ? `-${c.connectionId}` : ""}`) });
    }
    await markTranscriptsUnavailable(noProvider);
    if (jobs.length) {
      await registerChildJobs(a.proposal.id, jobs.map((j) => j.jobId));
      for (const j of jobs) await enqueue.transcript(j.videoId, j.provider, j.connectionId, a.auth, j.jobId);
    }
    for (let i = 0; i < changedVideoIds.length; i += 200) {
      const slice = changedVideoIds.slice(i, i + 200);
      await enqueue.embed("video", slice);
      await enqueue.topics(slice);
    }
    log().debug({ channel: channel.youtubeId, transcripts: jobs.length }, "queued downstream jobs");
  }
  if (channelChanged || changedVideoIds.length) await enqueue.embed("channel", [channel.id]); // classification follows embedding
  const dirty = [`channel:${channel.youtubeId}`, ...(await db.video.findMany({ where: { id: { in: changedVideoIds } }, select: { youtubeId: true } })).map((v) => `video:${v.youtubeId}`)];
  await enqueue.graph(dirty);
}

async function refreshLatest(channelId: string) {
  const latest = await db.video.findFirst({ where: { channelId }, orderBy: { publishedAt: "desc" }, select: { publishedAt: true } });
  await db.channel.update({ where: { id: channelId }, data: { latestVideoAt: latest?.publishedAt ?? null, lastSyncedAt: new Date() } });
}

// ── Upload history (checkpointed pages) ────────────────────────────────────

export const MORE_HISTORY: ReadonlySet<HistoryState> = new Set(["INITIAL_WINDOW_COLLECTED", "BACKFILL_IN_PROGRESS", "PAUSED_AWAITING_APPROVAL", "FAILED_RETRYABLE"]);

interface PageProgress {
  pages: number;
  items: number;
  created: number;
  updated: number;
  unavailable: number;
}
const zeroProgress = (): PageProgress => ({ pages: 0, items: 0, created: 0, updated: 0, unavailable: 0 });

/** Per-proposal progress for one channel, stored on the proposal and updated in the page transaction. */
async function progressOf(proposalId: string, key: string): Promise<PageProgress> {
  const p = await db.expansionProposal.findUnique({ where: { id: proposalId }, select: { actualResults: true } });
  const prog = ((p?.actualResults ?? {}) as { progress?: Record<string, PageProgress> }).progress?.[key];
  return { ...zeroProgress(), ...prog };
}

interface CollectOptions {
  /** Max playlist items this operation may consume in total (across slices/retries). */
  maxItems: number;
  /** Max pages this call may read (slice size); the overall page bound is enforced by the caller. */
  maxPages: number;
  progressKey: string;
  stateWhileRunning: HistoryState;
  /** State when the item bound is reached while history remains. */
  stateAtBound: HistoryState;
  onPage?: (p: PageProgress) => Promise<void>;
}

/**
 * Read the uploads playlist from the saved checkpoint, one page at a time. Per page, in one transaction: upsert the
 * page's videos + coverage, advance the checkpoint (token, offset, counters, oldest/newest) and the proposal's
 * progress. Returns the ids of created/updated videos for fan-out.
 */
async function collectHistory(channel: { id: string; youtubeId: string; uploadsPlaylistId: string }, a: AuthorizedJob, o: CollectOptions) {
  const changed: string[] = [];
  let progress = await progressOf(a.proposal.id, o.progressKey);
  let pagesThisCall = 0;
  let state: HistoryState = o.stateWhileRunning;
  let history = await db.uploadHistory.upsert({ where: { channelId: channel.id }, create: { channelId: channel.id }, update: {} });
  if (history.state === "COMPLETE_TO_SOURCE_LIMIT" && !history.nextPageToken && history.pagesScanned > 0) return { changed, progress, state: history.state, more: false };

  while (progress.items < o.maxItems && pagesThisCall < o.maxPages) {
    await assertStillRunning(a.proposal.id);
    const token = history.nextPageToken ?? undefined;
    const page = await youtube.getPlaylistItems(channel.uploadsPlaylistId, token);
    const remaining = o.maxItems - progress.items;
    const pageItems = page.items.slice(history.pageOffset);
    const take = pageItems.slice(0, remaining);
    const consumedWholePage = take.length === pageItems.length;
    const ids = take.map((i) => i.videoId);
    const vids = ids.length ? await youtube.getVideos(ids) : [];
    const at = new Date();
    const exhausted = consumedWholePage && !page.nextPageToken;
    state = exhausted ? "COMPLETE_TO_SOURCE_LIMIT" : o.stateWhileRunning;

    const result = await db.$transaction(async (tx) => {
      const s = await upsertVideos(ids, vids, channel.id, at, tx);
      const dates = [...s.publishedAts, ...take.map((t) => (t.publishedAt ? new Date(t.publishedAt) : null)).filter((d): d is Date => Boolean(d))];
      const oldest = dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))) : null;
      const newest = dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null;
      const h = await tx.uploadHistory.update({
        where: { channelId: channel.id },
        data: {
          state,
          nextPageToken: consumedWholePage ? (page.nextPageToken ?? null) : (token ?? null),
          pageOffset: consumedWholePage ? 0 : history.pageOffset + take.length,
          pagesScanned: { increment: 1 },
          itemsSeen: { increment: take.length },
          videosCollected: { increment: s.created.length },
          unavailableCount: { increment: s.notReturned.length + s.incomplete.length },
          totalResults: page.totalResults ?? undefined,
          lastPageAt: at,
          lastError: null,
          lastProposalId: a.proposal.id,
          completedAt: exhausted ? at : undefined,
          ...(oldest && (!history.oldestPublishedAt || oldest < history.oldestPublishedAt) ? { oldestPublishedAt: oldest } : {}),
          ...(newest && (!history.newestPublishedAt || newest > history.newestPublishedAt) ? { newestPublishedAt: newest } : {}),
        },
      });
      const next: PageProgress = {
        pages: progress.pages + 1,
        items: progress.items + take.length,
        created: progress.created + s.created.length,
        updated: progress.updated + s.updated.length,
        unavailable: progress.unavailable + s.notReturned.length + s.incomplete.length,
      };
      await tx.$executeRaw`
        UPDATE "ExpansionProposal" SET "actualResults" = jsonb_set(coalesce("actualResults", '{}'::jsonb) || jsonb_build_object('progress', coalesce("actualResults"->'progress', '{}'::jsonb)), ARRAY['progress', ${o.progressKey}], ${JSON.stringify(next)}::jsonb), "updatedAt" = now()
        WHERE id = ${a.proposal.id}`;
      return { s, h, next };
    }, TX);
    history = result.h;
    progress = result.next;
    pagesThisCall++;
    changed.push(...result.s.created, ...result.s.updated);
    if (result.s.notReturned.length) log().info({ channel: channel.youtubeId, ids: result.s.notReturned.slice(0, 10), n: result.s.notReturned.length }, "playlist items not returned by videos.list");
    await o.onPage?.(progress);
    if (exhausted) return { changed, progress, state, more: false };
  }
  const more = history.state !== "COMPLETE_TO_SOURCE_LIMIT";
  if (more && progress.items >= o.maxItems) {
    state = o.stateAtBound;
    await db.uploadHistory.update({ where: { channelId: channel.id }, data: { state } });
  }
  return { changed, progress, state, more };
}

async function loadChannelForCollection(youtubeId: string) {
  const c = await db.channel.findUnique({ where: { youtubeId }, select: { id: true, youtubeId: true, title: true, uploadsPlaylistId: true } });
  if (!c) throw new AppError("NOT_FOUND", `Channel ${youtubeId} is not in the atlas`);
  return c;
}

// ── Initial ingest (ADD_CHANNELS, discovery children) ──────────────────────

export interface IngestInput extends JobInput {
  youtubeId: string;
  aliases?: string[];
}

export interface IngestResult {
  status: "completed" | "skipped";
  channelId?: string;
  videos: { created: number; updated: number; seen: number; unavailable: number };
  units: number;
  featured: number;
  hasMore: boolean;
  historyState?: HistoryState;
}

export async function ingestChannel(input: IngestInput, ctl: JobControl): Promise<IngestResult> {
  const a = await authorizeJob(input.auth, ctl.jobId, ["ADD_CHANNELS", "DISCOVER_CHANNELS"], { channelYoutubeId: input.youtubeId });
  const res = await withLock(`ingest:${input.youtubeId}`, 900, () => ingestUnlocked(input, ctl, a));
  if (!res) throw new Error(`Channel ${input.youtubeId} is being collected by another job; will retry`); // plain Error ⇒ BullMQ retries
  return res;
}

async function ingestUnlocked(input: IngestInput, ctl: JobControl, a: AuthorizedJob<Extract<ExpansionScope, { kind: "ADD_CHANNELS" | "DISCOVER_CHANNELS" }>>): Promise<IngestResult> {
  const acc: RunAcc = { units: 0, searches: 0 };
  const run = await startRun("ingest", input.youtubeId, a, input.requestedBy);
  const emit = (pct: number, step: string, extra?: Record<string, unknown>) => ctl.progress(pct, step, { runId: run.id, proposalId: a.proposal.id, youtubeId: input.youtubeId, ...extra });
  const maxVideos = a.scope.maxVideosPerChannel;
  try {
    return await withYouTubeContext({ lane: input.lane, onCost: costTracker(acc) }, async () => {
      await emit(2, "details");
      const [yt] = await youtube.getChannels({ ids: [input.youtubeId] });
      if (!yt) {
        await db.channel.updateMany({ where: { youtubeId: input.youtubeId }, data: { isAvailable: false } });
        throw new AppError("NOT_FOUND", `Channel ${input.youtubeId} not found on YouTube`);
      }
      const at = new Date();
      const ch = await db.$transaction((tx) => upsertChannel(yt, input.aliases ?? [], at, tx), TX);
      const channel = await db.channel.findUniqueOrThrow({ where: { id: ch.id }, select: { id: true, youtubeId: true, title: true, uploadsPlaylistId: true } });
      await emit(10, "uploads", { channelId: channel.id, title: channel.title });

      let collected = { changed: [] as string[], progress: zeroProgress(), state: "NOT_STARTED" as HistoryState, more: false };
      if (channel.uploadsPlaylistId && maxVideos > 0) {
        collected = await collectHistory({ ...channel, uploadsPlaylistId: channel.uploadsPlaylistId }, a, {
          maxItems: maxVideos,
          maxPages: Math.ceil(maxVideos / 50) + 1,
          progressKey: channel.youtubeId,
          stateWhileRunning: "INITIAL_WINDOW_COLLECTED",
          stateAtBound: "INITIAL_WINDOW_COLLECTED",
          onPage: (p) => emit(10 + Math.min(70, (p.items / Math.max(maxVideos, 1)) * 70), "videos", { done: p.items, total: maxVideos }),
        });
      } else if (!channel.uploadsPlaylistId) {
        await db.uploadHistory.upsert({ where: { channelId: channel.id }, create: { channelId: channel.id, state: "SOURCE_UNAVAILABLE", lastError: "no uploads playlist" }, update: { state: "SOURCE_UNAVAILABLE", lastError: "no uploads playlist" } });
      } else {
        await db.uploadHistory.upsert({ where: { channelId: channel.id }, create: { channelId: channel.id }, update: {} });
      }

      await emit(82, "sections");
      const sections = await youtube.getChannelSections(channel.youtubeId);
      const featured = [...new Set(sections.flatMap((s) => s.channels).filter((id) => id !== channel.youtubeId))].slice(0, 100);
      await db.channel.update({ where: { id: channel.id }, data: { featuredChannelIds: featured } });

      await refreshLatest(channel.id);
      await emit(90, "queue-intelligence");
      await fanOut(channel, collected.changed, ch.changed || ch.created, a, a.scope.includeTranscripts);
      await updateTier(channel.id);

      const result: IngestResult = {
        status: "completed",
        channelId: channel.id,
        videos: { created: collected.progress.created, updated: collected.progress.updated, seen: collected.progress.items, unavailable: collected.progress.unavailable },
        units: acc.units,
        featured: featured.length,
        hasMore: collected.more,
        historyState: collected.state,
      };
      await finishRun(run.id, acc, "completed", { ...result.videos, featured: featured.length, hasMore: collected.more, historyState: collected.state });
      await emit(100, "done", { channelId: channel.id, created: collected.progress.created });
      return result;
    });
  } catch (err) {
    await finishRun(run.id, acc, "failed", {}, err instanceof Error ? err.message : String(err));
    await db.uploadHistory.updateMany({ where: { channel: { youtubeId: input.youtubeId } }, data: { lastError: (err instanceof Error ? err.message : String(err)).slice(0, 300) } });
    throw err;
  }
}

// ── Historical backfill (BACKFILL_HISTORY) ─────────────────────────────────

/** Pages per job slice; a slice re-enqueues its continuation at low priority so backfills never starve other work. */
export const BACKFILL_SLICE_PAGES = 10;

export interface BackfillInput extends JobInput {
  youtubeId: string;
  slice: number;
}

export async function backfillHistory(input: BackfillInput, ctl: JobControl) {
  const a = await authorizeJob(input.auth, ctl.jobId, "BACKFILL_HISTORY", { channelYoutubeId: input.youtubeId });
  const r = await withLock(`ingest:${input.youtubeId}`, 900, async () => {
    const acc: RunAcc = { units: 0, searches: 0 };
    const run = await startRun("backfill", input.youtubeId, a, input.requestedBy);
    try {
      return await withYouTubeContext({ lane: input.lane, onCost: costTracker(acc) }, async () => {
        let channel = await loadChannelForCollection(input.youtubeId);
        if (!channel.uploadsPlaylistId) {
          const [yt] = await youtube.getChannels({ ids: [input.youtubeId] });
          if (yt) await db.$transaction((tx) => upsertChannel(yt, [], new Date(), tx), TX);
          channel = await loadChannelForCollection(input.youtubeId);
          if (!channel.uploadsPlaylistId) throw new AppError("NOT_FOUND", "Channel has no uploads playlist");
        }
        const before = await progressOf(a.proposal.id, "backfill");
        const pagesLeft = a.scope.maxPages - before.pages;
        const out = await collectHistory({ ...channel, uploadsPlaylistId: channel.uploadsPlaylistId }, a, {
          maxItems: a.scope.maxVideos,
          maxPages: Math.max(0, Math.min(BACKFILL_SLICE_PAGES, pagesLeft)),
          progressKey: "backfill",
          stateWhileRunning: "BACKFILL_IN_PROGRESS",
          stateAtBound: "PAUSED_AWAITING_APPROVAL",
          onPage: (p) => ctl.progress(Math.min(99, (p.pages / a.scope.maxPages) * 100), "backfill", { runId: run.id, proposalId: a.proposal.id, pages: p.pages, items: p.items }),
        });
        const pageBoundHit = out.progress.pages >= a.scope.maxPages;
        let continuation: string | null = null;
        if (out.more && out.progress.items < a.scope.maxVideos && !pageBoundHit) {
          continuation = expansionJobId(a.proposal.id, `backfill-${input.slice + 1}`);
          await registerChildJobs(a.proposal.id, [continuation]);
          await enqueueExpansion("backfill-history", { auth: input.auth, lane: input.lane, requestedBy: input.requestedBy, youtubeId: input.youtubeId, slice: input.slice + 1 }, continuation);
        } else if (out.more) {
          // Approved bounds reached with history left: stop and wait for a new proposal.
          await db.uploadHistory.update({ where: { channelId: channel.id }, data: { state: "PAUSED_AWAITING_APPROVAL" } });
        }
        await refreshLatest(channel.id);
        await fanOut(channel, out.changed, false, a, a.scope.includeTranscripts);
        const stats = { ...out.progress, state: continuation ? "BACKFILL_IN_PROGRESS" : out.more ? "PAUSED_AWAITING_APPROVAL" : out.state, continuation };
        await finishRun(run.id, acc, "completed", stats);
        return { ...stats, units: acc.units };
      });
    } catch (err) {
      await finishRun(run.id, acc, "failed", {}, err instanceof Error ? err.message : String(err));
      await db.uploadHistory.updateMany({ where: { channel: { youtubeId: input.youtubeId } }, data: { state: "FAILED_RETRYABLE", lastError: (err instanceof Error ? err.message : String(err)).slice(0, 300) } });
      throw err;
    }
  });
  if (!r) throw new Error("Channel is being collected by another job; will retry");
  return r;
}

// ── Incremental sync (SYNC_UPLOADS) ────────────────────────────────────────

export interface SyncInput extends JobInput {
  youtubeId: string;
}

export interface SyncResult {
  newVideos: number;
  pages: number;
  units: number;
  boundReached: boolean;
}

/** Newest-first; stops at the first known upload or the approved per-channel bound. Refreshes the channel record. */
export async function syncChannel(input: SyncInput, ctl: JobControl): Promise<SyncResult> {
  const a = await authorizeJob(input.auth, ctl.jobId, "SYNC_UPLOADS", { channelYoutubeId: input.youtubeId });
  const channel = await loadChannelForCollection(input.youtubeId);
  const r = await withLock(`ingest:${channel.youtubeId}`, 600, async () => {
    const acc: RunAcc = { units: 0, searches: 0 };
    const run = await startRun("sync", channel.youtubeId, a, input.requestedBy);
    try {
      return await withYouTubeContext({ lane: input.lane, onCost: costTracker(acc), noCache: true }, async () => {
        await ctl.progress(5, "details", { runId: run.id, proposalId: a.proposal.id, channelId: channel.id });
        const [yt] = await youtube.getChannels({ ids: [channel.youtubeId] });
        if (!yt) {
          await db.channel.update({ where: { id: channel.id }, data: { isAvailable: false } });
          await finishRun(run.id, acc, "completed", { unavailable: true });
          return { newVideos: 0, pages: 0, units: acc.units, boundReached: false };
        }
        const ch = await db.$transaction((tx) => upsertChannel(yt, [], new Date(), tx), TX);
        const playlist = (await db.channel.findUniqueOrThrow({ where: { id: channel.id }, select: { uploadsPlaylistId: true } })).uploadsPlaylistId;
        const bound = a.scope.maxNewVideosPerChannel;
        const fresh: { videoId: string; publishedAt?: string }[] = [];
        let pages = 0;
        let token: string | undefined;
        let reachedKnown = false;
        if (playlist) {
          do {
            const page = await youtube.getPlaylistItems(playlist, token);
            pages++;
            const known = new Set((await db.video.findMany({ where: { youtubeId: { in: page.items.map((i) => i.videoId) } }, select: { youtubeId: true } })).map((v) => v.youtubeId));
            for (const item of page.items) {
              if (known.has(item.videoId)) {
                reachedKnown = true;
                break;
              }
              if (fresh.length >= bound) break;
              fresh.push(item);
            }
            token = page.nextPageToken;
          } while (token && !reachedKnown && fresh.length < bound);
        }
        await ctl.progress(40, "videos", { runId: run.id, found: fresh.length });
        const vs = emptyStats();
        for (let i = 0; i < fresh.length; i += 50) {
          await assertStillRunning(a.proposal.id);
          const ids = fresh.slice(i, i + 50).map((f) => f.videoId);
          const vids = await youtube.getVideos(ids);
          const s = await db.$transaction(async (tx) => {
            const s = await upsertVideos(ids, vids, channel.id, new Date(), tx);
            const newest = s.publishedAts.length ? new Date(Math.max(...s.publishedAts.map((d) => d.getTime()))) : null;
            await tx.uploadHistory.upsert({
              where: { channelId: channel.id },
              create: { channelId: channel.id, state: "INITIAL_WINDOW_COLLECTED", itemsSeen: ids.length, videosCollected: s.created.length, newestPublishedAt: newest },
              update: { itemsSeen: { increment: ids.length }, videosCollected: { increment: s.created.length }, unavailableCount: { increment: s.notReturned.length }, ...(newest ? { newestPublishedAt: newest } : {}) },
            });
            return s;
          }, TX);
          vs.created.push(...s.created);
          vs.updated.push(...s.updated);
          vs.notReturned.push(...s.notReturned);
        }
        // A bound hit before reaching a known upload means a gap: more new uploads exist than were approved.
        const boundReached = !reachedKnown && fresh.length >= bound;
        await refreshLatest(channel.id);
        await fanOut(channel, [...vs.created, ...vs.updated], ch.changed, a, a.scope.includeTranscripts);
        await updateTier(channel.id);
        await finishRun(run.id, acc, "completed", { newVideos: vs.created.length, pages, boundReached, notReturned: vs.notReturned.length });
        await ctl.progress(100, "done", { runId: run.id });
        return { newVideos: vs.created.length, pages, units: acc.units, boundReached };
      });
    } catch (err) {
      await finishRun(run.id, acc, "failed", {}, err instanceof Error ? err.message : String(err));
      throw err;
    }
  });
  if (!r) throw new Error("Channel is being collected by another job; will retry");
  return r;
}

// ── Metadata refresh (REFRESH_METADATA) ────────────────────────────────────

export interface RefreshInput extends JobInput {
  channelYoutubeIds: string[];
  videoYoutubeIds: string[];
}

/**
 * Re-fetch existing records. "all" re-applies every returned part (fixes the old partial refresh that advanced the
 * record-wide timestamp); "statistics" updates statistics only. Items the API no longer returns are deleted (with
 * derived data, via cascade); transient errors propagate so BullMQ retries the batch.
 */
export async function refreshMetadata(input: RefreshInput, ctl: JobControl) {
  const a = await authorizeJob(input.auth, ctl.jobId, "REFRESH_METADATA", { channelYoutubeIds: input.channelYoutubeIds, videoYoutubeIds: input.videoYoutubeIds });
  const acc: RunAcc = { units: 0, searches: 0 };
  const run = await startRun(`refresh-${a.scope.fields}`, input.channelYoutubeIds[0] ?? input.videoYoutubeIds[0] ?? "batch", a, input.requestedBy);
  const dirty = new Set<string>();
  const out = { channels: { refreshed: 0, deleted: 0 }, videos: { refreshed: 0, deleted: 0 } };
  try {
    await withYouTubeContext({ lane: input.lane, onCost: costTracker(acc), noCache: true }, async () => {
      if (input.channelYoutubeIds.length) {
        const fresh = await youtube.getChannels({ ids: input.channelYoutubeIds });
        const at = new Date();
        const returned = new Set(fresh.map((c) => c.id));
        for (const c of fresh) {
          if (a.scope.fields === "statistics") await applyChannelStatistics(c, at);
          else await db.$transaction((tx) => upsertChannel(c, [], at, tx), TX);
          dirty.add(`channel:${c.id}`);
          out.channels.refreshed++;
        }
        const gone = input.channelYoutubeIds.filter((id) => !returned.has(id));
        if (gone.length) {
          // Successful response without the item ⇒ deleted/terminated upstream ⇒ delete (with derived data).
          await db.channel.deleteMany({ where: { youtubeId: { in: gone } } });
          gone.forEach((id) => dirty.add(`channel:${id}`));
          out.channels.deleted += gone.length;
        }
      }
      if (input.videoYoutubeIds.length) {
        const fresh = await youtube.getVideos(input.videoYoutubeIds);
        const at = new Date();
        const returned = new Set(fresh.map((v) => v.id));
        const rows = await db.video.findMany({ where: { youtubeId: { in: input.videoYoutubeIds } }, select: { id: true, youtubeId: true, channelId: true, channel: { select: { youtubeId: true } } } });
        for (const v of fresh) {
          const row = rows.find((r) => r.youtubeId === v.id);
          if (!row) continue;
          if (a.scope.fields === "statistics") await applyVideoStatistics(v, row.id, at);
          else await db.$transaction((tx) => upsertVideos([v.id], [v], row.channelId, at, tx), TX);
          dirty.add(`video:${v.id}`);
          out.videos.refreshed++;
        }
        const gone = rows.filter((r) => !returned.has(r.youtubeId));
        if (gone.length) {
          await db.video.deleteMany({ where: { id: { in: gone.map((g) => g.id) } } });
          gone.forEach((g) => (dirty.add(`video:${g.youtubeId}`), dirty.add(`channel:${g.channel.youtubeId}`)));
          out.videos.deleted += gone.length;
        }
      }
    });
    if (dirty.size) await enqueue.graph([...dirty]);
    await finishRun(run.id, acc, "completed", out);
    return { ...out, units: acc.units };
  } catch (err) {
    await finishRun(run.id, acc, "failed", out, err instanceof Error ? err.message : String(err));
    const id = (yt: string[]) => db.video.findMany({ where: { youtubeId: { in: yt } }, select: { id: true } }).then((r) => r.map((x) => x.id));
    if (!(err instanceof AppError && err.code === "QUOTA_EXHAUSTED")) {
      await recordCoverageError({ videoIds: await id(input.videoYoutubeIds) }, ["STATISTICS"], err instanceof Error ? err.message : String(err)).catch(() => undefined);
    }
    throw err;
  }
}

async function applyChannelStatistics(c: YtChannel, at: Date) {
  const { data, coverage } = normalizeChannel(c);
  const row = await db.channel.findUnique({ where: { youtubeId: c.id }, select: { id: true } });
  if (!row) return;
  const stats = coverage.filter((g) => g.group === "STATISTICS");
  const keys = ["subscriberCount", "hiddenSubscriberCount", "viewCount", "videoCount"] as const;
  const patch = Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]));
  await db.$transaction(async (tx) => {
    await tx.channel.update({ where: { id: row.id }, data: { ...patch, ...(c.statistics ? { lastStatsAt: at } : {}) } });
    await recordCoverage([{ channelId: row.id, groups: stats }], "youtube:channels.list", at, tx);
  });
}

async function applyVideoStatistics(v: YtVideo, videoId: string, at: Date) {
  const { data, coverage } = normalizeVideo(v);
  const keys = ["viewCount", "likeCount", "commentCount"] as const;
  const patch = Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]));
  await db.$transaction(async (tx) => {
    await tx.video.update({ where: { id: videoId }, data: { ...patch, ...(v.statistics ? { lastStatsAt: at } : {}) } });
    await recordCoverage([{ videoId, groups: coverage.filter((g) => g.group === "STATISTICS") }], "youtube:videos.list", at, tx);
  });
}

// ── Discovery (DISCOVER_CHANNELS) ──────────────────────────────────────────

async function guessNiche(text: string) {
  const [v] = await embedTexts([text]);
  if (!v) return null;
  const rows = await db.$queryRaw<{ slug: string; sim: number }[]>`
    SELECT slug, 1 - (centroid <=> ${toVectorLiteral(v)}::vector) AS sim FROM "Niche"
    WHERE centroid IS NOT NULL AND depth = 1 ORDER BY centroid <=> ${toVectorLiteral(v)}::vector LIMIT 1`;
  return rows[0] ? { slug: rows[0].slug, similarity: +rows[0].sim.toFixed(3) } : null;
}

/**
 * Bounded discovery: ≤ queries.length searches (each ≤ maxCandidatesPerQuery results), channels.list enrichment,
 * then select up to maxChannelsToAdd candidates NOT already in Atlas (in result order) and ingest exactly those as
 * child jobs under the same approval. The selection is recorded once; replays are refused.
 */
export async function discoverChannelsApproved(input: JobInput, ctl: JobControl) {
  const a = await authorizeJob(input.auth, ctl.jobId, "DISCOVER_CHANNELS");
  const s = a.scope;
  const acc: RunAcc = { units: 0, searches: 0 };
  const run = await startRun("discover", s.nicheId ?? s.queries.join(" | ").slice(0, 200), a, input.requestedBy);
  try {
    const existingSel = channelSet(s, a.proposal);
    if (existingSel.size) {
      // Retry after selection was recorded: re-dispatch the same children (idempotent job IDs), never reselect.
      await dispatchDiscoveryChildren(a, [...existingSel], input);
      await finishRun(run.id, acc, "completed", { selected: existingSel.size, resumed: true });
      return { selected: [...existingSel], resumed: true };
    }
    if (input.requestedBy) await reserveUserDiscovery(input.requestedBy, s.queries.length);
    const hits: { channelId: string; title: string; description: string; query: string }[] = [];
    try {
      await withYouTubeContext({ lane: input.lane, onCost: costTracker(acc) }, async () => {
        for (const q of s.queries) {
          await assertStillRunning(a.proposal.id);
          const r = await youtube.searchChannels({ q, regionCode: s.regionCode, relevanceLanguage: s.relevanceLanguage, maxResults: s.maxCandidatesPerQuery });
          hits.push(...r.slice(0, s.maxCandidatesPerQuery).map((h) => ({ ...h, query: q })));
        }
      });
    } catch (e) {
      if (input.requestedBy) await refundUserDiscovery(input.requestedBy, s.queries.length);
      throw e;
    }
    const seen = new Set<string>();
    const unique = hits.filter((h) => !seen.has(h.channelId) && seen.add(h.channelId));
    const details = await withYouTubeContext({ lane: input.lane, onCost: costTracker(acc) }, () => youtube.getChannels({ ids: unique.map((h) => h.channelId) }));
    const byId = new Map(details.map((d) => [d.id, d]));
    const inAtlas = new Set((await db.channel.findMany({ where: { youtubeId: { in: unique.map((h) => h.channelId) } }, select: { youtubeId: true } })).map((c) => c.youtubeId));
    const candidates = [];
    for (const h of unique) {
      const d = byId.get(h.channelId);
      candidates.push({
        youtubeId: h.channelId,
        title: d?.snippet?.title ?? h.title,
        query: h.query,
        inAtlas: inAtlas.has(h.channelId),
        returnedByChannelsList: Boolean(d),
        subscriberCount: d?.statistics?.hiddenSubscriberCount ? null : d?.statistics?.subscriberCount !== undefined ? Number(d.statistics.subscriberCount) : null,
        nicheGuess: d ? await guessNiche(`${d.snippet?.title ?? ""}\n${d.snippet?.description ?? ""}`).catch(() => null) : null,
      });
    }
    const selected = candidates.filter((c) => !c.inAtlas && c.returnedByChannelsList).slice(0, s.maxChannelsToAdd).map((c) => c.youtubeId);
    await recordDiscoverySelection(a.proposal.id, s.maxChannelsToAdd, selected, candidates);
    await db.discoveryQuery.create({ data: { userId: input.requestedBy, query: s.queries.join(" | "), nicheId: s.nicheId, resultChannelIds: candidates.map((c) => c.youtubeId) } });
    // CO_DISCOVERED edges among channels already present (cross-owner relation — gated for live data in the builder).
    const present = candidates.filter((c) => c.inAtlas).map((c) => `channel:${c.youtubeId}`);
    if (present.length > 1 && policyAllows("cross-owner-aggregation")) await enqueue.graph(present);
    await dispatchDiscoveryChildren(a, selected, input);
    const stats = { searches: acc.searches, candidates: candidates.length, alreadyInAtlas: candidates.filter((c) => c.inAtlas).length, selected: selected.length };
    await finishRun(run.id, acc, "completed", stats);
    return { ...stats, units: acc.units };
  } catch (err) {
    await finishRun(run.id, acc, "failed", {}, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

async function dispatchDiscoveryChildren(a: AuthorizedJob, selected: string[], input: JobInput) {
  const jobs = selected.map((yt) => ({ yt, jobId: expansionJobId(a.proposal.id, `ingest-${yt}`) }));
  await registerChildJobs(a.proposal.id, jobs.map((j) => j.jobId));
  for (const j of jobs) await enqueueExpansion("ingest-channel", { auth: input.auth, lane: input.lane, requestedBy: input.requestedBy, youtubeId: j.yt }, j.jobId);
}

// ── Tiers ──────────────────────────────────────────────────────────────────

export const TIER_INTERVAL_MS: Record<SyncTier, number> = {
  HOT: 6 * 3600_000,
  WARM: 24 * 3600_000,
  COLD: 7 * 24 * 3600_000,
};

/** HOT: in any collection or viewed in the last 7 days. COLD: no uploads in 180 days. WARM: everything else. */
export async function computeTier(channelId: string): Promise<SyncTier> {
  const c = await db.channel.findUnique({ where: { id: channelId }, select: { youtubeId: true, lastViewedAt: true, latestVideoAt: true } });
  if (!c) return "WARM";
  const inCollection = await db.collectionItem.count({ where: { nodeId: `channel:${c.youtubeId}` } });
  if (inCollection > 0 || (c.lastViewedAt && Date.now() - c.lastViewedAt.getTime() < 7 * 86_400_000)) return "HOT";
  if (c.latestVideoAt && Date.now() - c.latestVideoAt.getTime() > 180 * 86_400_000) return "COLD";
  return "WARM";
}

export async function updateTier(channelId: string) {
  const tier = await computeTier(channelId);
  await db.channel.update({ where: { id: channelId }, data: { syncTier: tier } });
  return tier;
}

export async function markViewed(youtubeIdOrId: string) {
  await db.channel.updateMany({ where: { OR: [{ id: youtubeIdOrId }, { youtubeId: youtubeIdOrId }] }, data: { lastViewedAt: new Date(), syncTier: "HOT" } });
}

// ── Schedulers → SYSTEM proposals (never direct collection) ────────────────

/** Approx. units for one incremental sync (channels.list + first uploads page + one videos.list). */
const SYNC_COST_ESTIMATE = 3;
export const SYSTEM_SYNC_NEW_VIDEOS = 50;

async function pendingSystem(kind: "SYNC_UPLOADS" | "REFRESH_METADATA", purpose?: string) {
  const rows = await db.expansionProposal.findMany({ where: { source: "SYSTEM", kind, status: { in: ["PENDING", "APPROVED", "RUNNING"] } }, select: { id: true, scope: true } });
  return rows.find((r) => !purpose || (r.scope as { purpose?: string }).purpose === purpose) ?? null;
}

/**
 * Every 15 min: channels due by tier become ONE pending SYSTEM proposal (an admin approves it). Nothing is fetched
 * until then, so scheduled jobs can never silently add new uploads.
 */
export async function scheduleDueSyncs(): Promise<{ proposed: number; proposalId?: string; budgetLimited: boolean; skipped?: string }> {
  if (!policyAllows("live-collection")) return { proposed: 0, budgetLimited: false, skipped: "policy" };
  if (await pendingSystem("SYNC_UPLOADS")) return { proposed: 0, budgetLimited: false, skipped: "pending proposal exists" };
  const u = await quota.usage();
  const general = u.buckets.find((b) => b.bucket === "general")!;
  const budget = Math.max(0, general.backgroundCap - general.used);
  const maxChannels = Math.min(500, Math.floor(budget / SYNC_COST_ESTIMATE));
  if (maxChannels <= 0) return { proposed: 0, budgetLimited: true };
  const now = Date.now();
  const due = await db.channel.findMany({
    where: {
      isAvailable: true,
      OR: (Object.keys(TIER_INTERVAL_MS) as SyncTier[]).map((tier) => ({
        syncTier: tier,
        OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: new Date(now - TIER_INTERVAL_MS[tier]) } }],
      })),
    },
    orderBy: [{ syncTier: "asc" }, { lastSyncedAt: { sort: "asc", nulls: "first" } }],
    take: maxChannels,
    select: { youtubeId: true },
  });
  if (!due.length) return { proposed: 0, budgetLimited: false };
  const p = await createProposal(
    {
      scope: { kind: "SYNC_UPLOADS", channelYoutubeIds: due.map((d) => d.youtubeId), maxNewVideosPerChannel: SYSTEM_SYNC_NEW_VIDEOS, includeTranscripts: true },
      reason: `Scheduled check: ${due.length} channel(s) are due for an upload sync by tier (HOT 6 h, WARM 1 d, COLD 7 d).`,
      coverageGap: "New uploads published since the last sync are not in the atlas yet.",
    },
    { kind: "system" },
  );
  return { proposed: due.length, proposalId: p.id, budgetLimited: due.length === maxChannels };
}

/** Hourly: recent videos whose statistics are older than their tier window → one pending SYSTEM statistics proposal. */
export async function scheduleStatsRefresh(): Promise<{ proposed: number; proposalId?: string; skipped?: string }> {
  if (!policyAllows("live-collection")) return { proposed: 0, skipped: "policy" };
  if (await pendingSystem("REFRESH_METADATA", "statistics")) return { proposed: 0, skipped: "pending proposal exists" };
  const now = Date.now();
  const rows = await db.video.findMany({
    where: {
      isAvailable: true,
      OR: [
        { channel: { syncTier: "HOT" }, publishedAt: { gt: new Date(now - 90 * 86_400_000) }, OR: [{ lastStatsAt: null }, { lastStatsAt: { lt: new Date(now - 6 * 3600_000) } }] },
        { channel: { syncTier: "WARM" }, publishedAt: { gt: new Date(now - 30 * 86_400_000) }, OR: [{ lastStatsAt: null }, { lastStatsAt: { lt: new Date(now - 24 * 3600_000) } }] },
      ],
    },
    orderBy: { lastStatsAt: { sort: "asc", nulls: "first" } },
    take: 50 * 40,
    select: { youtubeId: true },
  });
  if (!rows.length) return { proposed: 0 };
  const p = await createProposal(
    {
      scope: { kind: "REFRESH_METADATA", channelYoutubeIds: [], videoYoutubeIds: rows.map((r) => r.youtubeId), fields: "statistics", purpose: "statistics" },
      reason: `Statistics for ${rows.length} recent video(s) are older than their tier's refresh window.`,
      coverageGap: "View/like/comment counts may be out of date.",
    },
    { kind: "system" },
  );
  return { proposed: rows.length, proposalId: p.id };
}
