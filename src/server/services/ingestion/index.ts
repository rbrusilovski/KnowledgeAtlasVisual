import { db, type Prisma, type SyncTier } from "@/server/db";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { enqueue, type Lane } from "@/server/jobs";
import { log } from "@/server/logger";
import { youtube, withYouTubeContext, bestThumb, parseIsoDuration, type YtChannel, type YtVideo } from "@/server/youtube";
import * as quota from "@/server/services/quota";
import { withLock } from "@/server/services/cache";
import { publish } from "@/server/services/realtime";
import { autoProviderFor } from "@/server/services/transcripts";

// ── Mapping ────────────────────────────────────────────────────────────────

/** Brand keywords arrive as a space-separated string with "quoted phrases". */
export function parseKeywords(s?: string): string[] {
  if (!s) return [];
  const out: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push((m[1] ?? m[2]!).trim().toLowerCase());
  return [...new Set(out.filter(Boolean))].slice(0, 50);
}

function channelData(c: YtChannel) {
  const handle = c.snippet?.customUrl?.startsWith("@") ? c.snippet.customUrl.slice(1).toLowerCase() : null;
  return {
    youtubeId: c.id,
    handle,
    title: c.snippet?.title ?? c.id,
    description: c.snippet?.description ?? "",
    customUrl: c.snippet?.customUrl ?? null,
    country: c.snippet?.country ?? null,
    publishedAt: c.snippet?.publishedAt ? new Date(c.snippet.publishedAt) : null,
    thumbnailUrl: bestThumb(c.snippet?.thumbnails) ?? null,
    keywords: parseKeywords(c.brandingSettings?.channel?.keywords),
    topicCategories: c.topicDetails?.topicCategories ?? [],
    subscriberCount: c.statistics?.hiddenSubscriberCount ? null : (c.statistics?.subscriberCount ?? null),
    hiddenSubscriberCount: c.statistics?.hiddenSubscriberCount ?? false,
    videoCount: c.statistics?.videoCount !== undefined ? Number(c.statistics.videoCount) : null,
    viewCount: c.statistics?.viewCount ?? null,
    uploadsPlaylistId: c.contentDetails?.relatedPlaylists?.uploads ?? null,
    etag: c.etag ?? null,
  };
}

function videoData(v: YtVideo, channelId: string) {
  const durationSec = parseIsoDuration(v.contentDetails?.duration) ?? null;
  return {
    youtubeId: v.id,
    channelId,
    title: v.snippet?.title ?? v.id,
    description: v.snippet?.description ?? "",
    publishedAt: new Date(v.snippet?.publishedAt ?? Date.now()),
    durationSec,
    tags: (v.snippet?.tags ?? []).slice(0, 60),
    categoryId: v.snippet?.categoryId ?? null,
    defaultLanguage: v.snippet?.defaultLanguage ?? v.snippet?.defaultAudioLanguage ?? null,
    thumbnailUrl: bestThumb(v.snippet?.thumbnails) ?? null,
    viewCount: v.statistics?.viewCount ?? null,
    likeCount: v.statistics?.likeCount ?? null,
    commentCount: v.statistics?.commentCount ?? null,
    isShort: durationSec !== null && durationSec <= 60,
    etag: v.etag ?? null,
  };
}

// ── Run bookkeeping ────────────────────────────────────────────────────────

export interface JobControl {
  jobId: string;
  progress(pct: number, step: string, extra?: Record<string, unknown>): Promise<void>;
}

interface RunAcc {
  units: number;
  searches: number;
}

async function startRun(kind: string, targetId: string, requestedBy?: string) {
  return db.ingestionRun.create({ data: { kind, targetId, status: "running", requestedBy }, select: { id: true } });
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

export async function emitJobEvent(
  type: "job.progress" | "job.completed" | "job.failed",
  payload: Record<string, unknown> & { jobId: string },
  requestedBy?: string,
) {
  // User-initiated jobs go to that user's channel only (no duplicate delivery); background jobs are global.
  await publish({ type, scope: requestedBy ? { userId: requestedBy } : "global", payload });
}

// ── Upserts ────────────────────────────────────────────────────────────────

async function upsertChannel(c: YtChannel, aliases: string[]) {
  const data = channelData(c);
  const existing = await db.channel.findUnique({ where: { youtubeId: c.id }, select: { id: true, etag: true, handle: true } });
  // Handle uniqueness: if another (stale) row holds this handle, release it.
  if (data.handle) await db.channel.updateMany({ where: { handle: data.handle, NOT: { youtubeId: c.id } }, data: { handle: null } });
  const now = new Date();
  let id: string;
  let changed = true;
  if (existing && existing.etag && existing.etag === data.etag) {
    changed = false;
    id = existing.id;
    await db.channel.update({ where: { id }, data: { lastRefreshedAt: now, isAvailable: true } });
  } else if (existing) {
    id = existing.id;
    await db.channel.update({ where: { id }, data: { ...data, lastRefreshedAt: now, lastStatsAt: now, isAvailable: true } });
  } else {
    id = (await db.channel.create({ data: { ...data, lastRefreshedAt: now, lastStatsAt: now }, select: { id: true } })).id;
  }
  const allAliases = new Set([`id:${c.id}`, ...aliases]);
  if (data.handle) allAliases.add(`handle:${data.handle}`);
  if (data.customUrl && !data.customUrl.startsWith("@")) allAliases.add(`custom:${data.customUrl.toLowerCase()}`);
  for (const value of allAliases) {
    await db.channelAlias.upsert({
      where: { value },
      create: { channelId: id, kind: value.split(":")[0]!, value },
      update: { channelId: id },
    });
  }
  return { id, created: !existing, changed };
}

interface VideoWriteStats {
  created: string[];
  updated: string[];
  skipped: number;
}

async function upsertVideos(videos: YtVideo[], channelId: string): Promise<VideoWriteStats> {
  const stats: VideoWriteStats = { created: [], updated: [], skipped: 0 };
  if (!videos.length) return stats;
  const existing = await db.video.findMany({
    where: { youtubeId: { in: videos.map((v) => v.id) } },
    select: { id: true, youtubeId: true, etag: true, lastRefreshedAt: true, channelId: true },
  });
  const byYt = new Map(existing.map((e) => [e.youtubeId, e]));
  const now = new Date();
  const dayAgo = Date.now() - 86_400_000;
  const refreshOnly: string[] = [];
  for (const v of videos) {
    const prev = byYt.get(v.id);
    const data = videoData(v, channelId);
    if (!prev) {
      const row = await db.video.create({ data: { ...data, lastRefreshedAt: now, lastStatsAt: now }, select: { id: true } });
      stats.created.push(row.id);
    } else if (prev.etag && prev.etag === data.etag && prev.channelId === channelId) {
      stats.skipped++;
      if (!prev.lastRefreshedAt || prev.lastRefreshedAt.getTime() < dayAgo) refreshOnly.push(prev.id);
    } else {
      await db.video.update({ where: { id: prev.id }, data: { ...data, lastRefreshedAt: now, lastStatsAt: now, isAvailable: true } });
      stats.updated.push(prev.id);
    }
  }
  if (refreshOnly.length) await db.video.updateMany({ where: { id: { in: refreshOnly } }, data: { lastRefreshedAt: now } });
  return stats;
}

async function fetchAndUpsertVideoIds(ids: string[], channelId: string, onBatch?: (done: number) => Promise<void>) {
  const total: VideoWriteStats = { created: [], updated: [], skipped: 0 };
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const vids = await youtube.getVideos(batch);
    const s = await upsertVideos(vids, channelId);
    total.created.push(...s.created);
    total.updated.push(...s.updated);
    total.skipped += s.skipped;
    await onBatch?.(Math.min(ids.length, i + 50));
  }
  return total;
}

// ── Downstream fan-out ─────────────────────────────────────────────────────

async function fanOut(channel: { id: string; youtubeId: string }, changedVideoIds: string[], channelChanged: boolean) {
  if (changedVideoIds.length) {
    const vids = await db.video.findMany({ where: { id: { in: changedVideoIds }, hasTranscript: false }, select: { id: true, youtubeId: true } });
    let transcripts = 0;
    for (const v of vids) {
      const provider = await autoProviderFor({ id: v.id, youtubeId: v.youtubeId, channelYoutubeId: channel.youtubeId });
      if (provider) {
        await enqueue.transcript(v.id, provider);
        transcripts++;
      }
    }
    for (let i = 0; i < changedVideoIds.length; i += 200) {
      const slice = changedVideoIds.slice(i, i + 200);
      await enqueue.embed("video", slice);
      await enqueue.topics(slice);
    }
    log().debug({ channel: channel.youtubeId, transcripts }, "queued downstream jobs");
  }
  if (channelChanged || changedVideoIds.length) {
    // Channel embedding uses recent video titles, so refresh it whenever videos change. Classification follows embedding.
    await enqueue.embed("channel", [channel.id]);
  }
  const dirty = [`channel:${channel.youtubeId}`, ...(await db.video.findMany({ where: { id: { in: changedVideoIds } }, select: { youtubeId: true } })).map((v) => `video:${v.youtubeId}`)];
  await enqueue.graph(dirty);
}

async function refreshLatest(channelId: string) {
  const latest = await db.video.findFirst({ where: { channelId }, orderBy: { publishedAt: "desc" }, select: { publishedAt: true } });
  await db.channel.update({ where: { id: channelId }, data: { latestVideoAt: latest?.publishedAt ?? null, lastSyncedAt: new Date() } });
}

// ── Initial ingest ─────────────────────────────────────────────────────────

export interface IngestInput {
  youtubeId: string;
  requestedBy?: string;
  full?: boolean;
  aliases?: string[];
  lane: Lane;
}

export interface IngestResult {
  status: "completed" | "skipped";
  channelId?: string;
  videos: { created: number; updated: number; skipped: number; seen: number };
  units: number;
  featured: number;
  hasMore: boolean;
}

/**
 * channel details → uploads playlist newest-first (≤ INGEST_MAX_VIDEOS_PER_CHANNEL, or continue from
 * backfillPageToken when `full`) → videos.list batches → channelSections → transcripts → embed → topics →
 * classify → graph-build. Never uses search.list.
 */
export async function ingestChannel(input: IngestInput, ctl: JobControl): Promise<IngestResult> {
  const res = await withLock(`ingest:${input.youtubeId}`, 900, () => ingestUnlocked(input, ctl));
  if (!res) return { status: "skipped", videos: { created: 0, updated: 0, skipped: 0, seen: 0 }, units: 0, featured: 0, hasMore: false };
  return res;
}

async function ingestUnlocked(input: IngestInput, ctl: JobControl): Promise<IngestResult> {
  const acc: RunAcc = { units: 0, searches: 0 };
  const run = await startRun(input.full ? "ingest-full" : "ingest", input.youtubeId, input.requestedBy);
  const emit = (pct: number, step: string, extra?: Record<string, unknown>) => ctl.progress(pct, step, { runId: run.id, youtubeId: input.youtubeId, ...extra });
  try {
    return await withYouTubeContext({ lane: input.lane, onCost: costTracker(acc) }, async () => {
      await emit(2, "details");
      const [yt] = await youtube.getChannels({ ids: [input.youtubeId] });
      if (!yt) {
        await db.channel.updateMany({ where: { youtubeId: input.youtubeId }, data: { isAvailable: false } });
        throw new AppError("NOT_FOUND", `Channel ${input.youtubeId} not found on YouTube`);
      }
      const ch = await upsertChannel(yt, input.aliases ?? []);
      const channel = await db.channel.findUniqueOrThrow({ where: { id: ch.id }, select: { id: true, youtubeId: true, title: true, uploadsPlaylistId: true, backfillPageToken: true } });
      await emit(10, "uploads", { channelId: channel.id, title: channel.title });

      // Page the uploads playlist.
      const ids: string[] = [];
      let token: string | undefined = input.full ? (channel.backfillPageToken ?? undefined) : undefined;
      const cap = input.full ? 5_000 : env.INGEST_MAX_VIDEOS_PER_CHANNEL;
      let hasMore = false;
      if (channel.uploadsPlaylistId) {
        do {
          const page = await youtube.getPlaylistItems(channel.uploadsPlaylistId, token);
          ids.push(...page.items.map((i) => i.videoId));
          token = page.nextPageToken;
          await emit(10 + Math.min(25, (ids.length / Math.max(cap, 1)) * 25), "uploads", { seen: ids.length });
        } while (token && ids.length < cap);
        hasMore = Boolean(token);
      }
      await db.channel.update({ where: { id: channel.id }, data: { backfillPageToken: hasMore ? (token ?? null) : null } });

      await emit(35, "videos", { total: ids.length });
      const vs = await fetchAndUpsertVideoIds(ids, channel.id, (done) => emit(35 + (done / Math.max(ids.length, 1)) * 45, "videos", { done, total: ids.length }));

      await emit(82, "sections");
      const sections = await youtube.getChannelSections(channel.youtubeId);
      const featured = [...new Set(sections.flatMap((s) => s.channels).filter((id) => id !== channel.youtubeId))].slice(0, 100);
      await db.channel.update({ where: { id: channel.id }, data: { featuredChannelIds: featured } });

      await refreshLatest(channel.id);
      await emit(90, "queue-intelligence");
      const changed = [...vs.created, ...vs.updated];
      await fanOut(channel, changed, ch.changed || ch.created);
      await updateTier(channel.id);

      const result: IngestResult = {
        status: "completed",
        channelId: channel.id,
        videos: { created: vs.created.length, updated: vs.updated.length, skipped: vs.skipped, seen: ids.length },
        units: acc.units,
        featured: featured.length,
        hasMore,
      };
      await finishRun(run.id, acc, "completed", { ...result.videos, featured: featured.length, hasMore });
      await emit(100, "done", { channelId: channel.id, created: vs.created.length });
      return result;
    });
  } catch (err) {
    await finishRun(run.id, acc, "failed", {}, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

// ── Incremental sync ───────────────────────────────────────────────────────

export interface SyncResult {
  newVideos: number;
  pages: number;
  units: number;
}

/** Page uploads newest-first and stop at the first known video ID (usually 1 unit) + refresh channel stats. */
export async function syncChannel(channelId: string, lane: Lane, ctl: JobControl, requestedBy?: string): Promise<SyncResult> {
  const channel = await db.channel.findUnique({ where: { id: channelId }, select: { id: true, youtubeId: true, uploadsPlaylistId: true } });
  if (!channel) throw new AppError("NOT_FOUND", "Channel not found");
  const r = await withLock(`ingest:${channel.youtubeId}`, 600, async () => {
    const acc: RunAcc = { units: 0, searches: 0 };
    const run = await startRun("sync", channel.youtubeId, requestedBy);
    try {
      return await withYouTubeContext({ lane, onCost: costTracker(acc), noCache: true }, async () => {
        await ctl.progress(5, "details", { runId: run.id, channelId });
        const [yt] = await youtube.getChannels({ ids: [channel.youtubeId] });
        if (!yt) {
          await db.channel.update({ where: { id: channel.id }, data: { isAvailable: false } });
          await finishRun(run.id, acc, "completed", { unavailable: true });
          return { newVideos: 0, pages: 0, units: acc.units };
        }
        const ch = await upsertChannel(yt, []);
        const known = new Set((await db.video.findMany({ where: { channelId: channel.id }, select: { youtubeId: true } })).map((v) => v.youtubeId));
        const fresh: string[] = [];
        let pages = 0;
        let token: string | undefined;
        if (channel.uploadsPlaylistId) {
          outer: do {
            const page = await youtube.getPlaylistItems(channel.uploadsPlaylistId, token);
            pages++;
            for (const item of page.items) {
              if (known.has(item.videoId)) break outer;
              fresh.push(item.videoId);
            }
            token = page.nextPageToken;
          } while (token && fresh.length < env.INGEST_MAX_VIDEOS_PER_CHANNEL);
        }
        await ctl.progress(40, "videos", { runId: run.id, found: fresh.length });
        const vs = await fetchAndUpsertVideoIds(fresh, channel.id);
        await refreshLatest(channel.id);
        const changed = [...vs.created, ...vs.updated];
        await fanOut(channel, changed, ch.changed);
        await updateTier(channel.id);
        await finishRun(run.id, acc, "completed", { newVideos: vs.created.length, pages });
        await ctl.progress(100, "done", { runId: run.id });
        return { newVideos: vs.created.length, pages, units: acc.units };
      });
    } catch (err) {
      await finishRun(run.id, acc, "failed", {}, err instanceof Error ? err.message : String(err));
      throw err;
    }
  });
  return r ?? { newVideos: 0, pages: 0, units: 0 };
}

// ── Stats refresh ──────────────────────────────────────────────────────────

export async function refreshStats(videoYoutubeIds: string[], lane: Lane = "background") {
  const acc: RunAcc = { units: 0, searches: 0 };
  return withYouTubeContext({ lane, onCost: costTracker(acc), noCache: true }, async () => {
    const vids = await youtube.getVideos(videoYoutubeIds);
    const returned = new Set(vids.map((v) => v.id));
    const now = new Date();
    for (const v of vids) {
      await db.video.updateMany({
        where: { youtubeId: v.id },
        data: {
          viewCount: v.statistics?.viewCount ?? null,
          likeCount: v.statistics?.likeCount ?? null,
          commentCount: v.statistics?.commentCount ?? null,
          etag: v.etag ?? null,
          lastStatsAt: now,
          lastRefreshedAt: now,
        },
      });
    }
    const missing = videoYoutubeIds.filter((id) => !returned.has(id));
    return { updated: vids.length, missing, units: acc.units };
  });
}

// ── Tiers & scheduling ─────────────────────────────────────────────────────

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

/** Approx. units for one incremental sync (channels.list + first uploads page + one videos.list). */
const SYNC_COST_ESTIMATE = 3;

/** Every 15 min: enqueue channels that are due, within the background quota budget. */
export async function scheduleDueSyncs(): Promise<{ enqueued: number; budgetLimited: boolean }> {
  const u = await quota.usage();
  const general = u.buckets.find((b) => b.bucket === "general")!;
  const budget = Math.max(0, general.backgroundCap - general.used);
  const maxChannels = Math.min(500, Math.floor(budget / SYNC_COST_ESTIMATE));
  if (maxChannels <= 0) return { enqueued: 0, budgetLimited: true };
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
    select: { id: true },
  });
  for (const c of due) await enqueue.sync(c.id, "background");
  return { enqueued: due.length, budgetLimited: due.length === maxChannels };
}

/** Hourly: batch videos.list stats for recent videos (HOT: last 90 days every 6h; WARM: last 30 days daily). */
export async function scheduleStatsRefresh(): Promise<{ batches: number }> {
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
  let batches = 0;
  for (let i = 0; i < rows.length; i += 50) {
    if (!(await quota.canSpend("general", batches + 1, "background"))) break;
    await enqueue.stats(rows.slice(i, i + 50).map((r) => r.youtubeId));
    batches++;
  }
  return { batches };
}
