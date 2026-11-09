/**
 * Unified field-level coverage (what Atlas knows about each channel/video, why something is missing, and when it must
 * be refreshed or deleted). Writes happen during approved collection; every read here is side-effect free so it can
 * back the UI and future Claude inspection tools.
 */
import { db, Prisma, type CoverageGroup, type CoverageStatus, type RetentionClass, type TranscriptStatus } from "@/server/db";
import { env } from "@/server/env";
import { notFound } from "@/server/errors";
import {
  policyStatus,
  REQUIRED_CHANNEL_GROUPS,
  REQUIRED_VIDEO_GROUPS,
  RESOLVED_STATUSES,
  type GroupCoverage,
} from "@/server/youtube";

const DAY = 86_400_000;
/** Retention for Non-Authorized API Data (Developer Policies III.E.4.d). */
export const API_RETENTION_DAYS = 30;
/** Derived Metrics Policy: qualifying statistics up to 36 calendar months, only with the amendment accepted. */
export const EXTENDED_STATS_RETENTION_DAYS = 36 * 30;

export function retentionClassFor(group: CoverageGroup, opts: { fixtureTranscript?: boolean } = {}): RetentionClass {
  if (group === "STATISTICS") return "API_STATISTICS";
  if (group === "TRANSCRIPT") return opts.fixtureTranscript ? "FIXTURE" : "USER_CONTENT";
  return "API_METADATA";
}

export function retentionDays(cls: RetentionClass): number | null {
  if (cls === "API_METADATA" || cls === "AUTHORIZED_DATA") return API_RETENTION_DAYS;
  if (cls === "API_STATISTICS") return policyStatus().extendedStatisticsRetention ? EXTENDED_STATS_RETENTION_DAYS : API_RETENTION_DAYS;
  return null; // USER_CONTENT / FIXTURE: not API Data
}

export function deadlineFrom(cls: RetentionClass, lastSuccessAt: Date): Date | null {
  const days = retentionDays(cls);
  return days === null ? null : new Date(lastSuccessAt.getTime() + days * DAY);
}

/** Effective status for display: resolved data inside the refresh lead window counts as STALE. */
export function effectiveStatus(row: { status: CoverageStatus; retentionDeadline: Date | null }, now = new Date()): CoverageStatus {
  if (RESOLVED_STATUSES.has(row.status) && row.retentionDeadline && row.retentionDeadline.getTime() - now.getTime() < env.COMPLIANCE_REFRESH_LEAD_DAYS * DAY) return "STALE";
  return row.status;
}

// ── Writes ─────────────────────────────────────────────────────────────────

export interface CoverageWrite {
  channelId?: string;
  videoId?: string;
  groups: GroupCoverage[];
}

/**
 * Upsert coverage rows. Resolved statuses advance `lastSuccessAt` and the retention deadline; NOT_RETURNED / ERROR
 * only record the attempt, so a partial response never extends how long previously collected data may be kept.
 */
export async function recordCoverage(writes: CoverageWrite[], source: string, at = new Date(), tx: Prisma.TransactionClient = db) {
  const rows = writes.flatMap((w) =>
    w.groups.map((g) => {
      const cls = retentionClassFor(g.group);
      const resolved = RESOLVED_STATUSES.has(g.status);
      return Prisma.sql`(${`cov_${w.channelId ?? w.videoId}_${g.group}`}, ${w.channelId ?? null}, ${w.videoId ?? null}, ${g.group}::"CoverageGroup", ${g.status}::"CoverageStatus",
        ${source}, ${g.reason ?? null}, ${g.details ? JSON.stringify(g.details) : null}::jsonb, ${cls}::"RetentionClass", ${at},
        ${resolved ? at : null}::timestamp, ${resolved ? deadlineFrom(cls, at) : null}::timestamp, ${g.status === "ERROR" ? (g.reason ?? "error") : null}, now())`;
    }),
  );
  for (let i = 0; i < rows.length; i += 500) {
    const values = Prisma.join(rows.slice(i, i + 500));
    // Two arbiter indexes (channel vs video) → split by which FK is set.
    await tx.$executeRaw`
      INSERT INTO "FieldCoverage" (id, "channelId", "videoId", "group", status, source, reason, details, "retentionClass", "lastAttemptAt", "lastSuccessAt", "retentionDeadline", error, "updatedAt")
      VALUES ${values}
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status, source = EXCLUDED.source, reason = EXCLUDED.reason,
        details = coalesce(EXCLUDED.details, "FieldCoverage".details), "retentionClass" = EXCLUDED."retentionClass",
        "lastAttemptAt" = EXCLUDED."lastAttemptAt",
        "lastSuccessAt" = coalesce(EXCLUDED."lastSuccessAt", "FieldCoverage"."lastSuccessAt"),
        "retentionDeadline" = CASE WHEN EXCLUDED."lastSuccessAt" IS NOT NULL THEN EXCLUDED."retentionDeadline" ELSE "FieldCoverage"."retentionDeadline" END,
        error = EXCLUDED.error, "updatedAt" = now()`;
  }
}

/** Mark groups as attempted-but-failed (transient error) without touching freshness. */
export async function recordCoverageError(target: { channelIds?: string[]; videoIds?: string[] }, groups: CoverageGroup[], error: string, at = new Date()) {
  const writes: CoverageWrite[] = [
    ...(target.channelIds ?? []).map((channelId) => ({ channelId, groups: groups.map((group) => ({ group, status: "ERROR" as const, reason: error.slice(0, 300) })) })),
    ...(target.videoIds ?? []).map((videoId) => ({ videoId, groups: groups.map((group) => ({ group, status: "ERROR" as const, reason: error.slice(0, 300) })) })),
  ];
  await recordCoverage(writes, "error", at);
}

const TRANSCRIPT_COVERAGE: Record<TranscriptStatus, CoverageStatus> = {
  AVAILABLE: "PRESENT",
  NOT_AVAILABLE: "UNAVAILABLE",
  REQUIRES_USER_UPLOAD: "UNAVAILABLE",
  NOT_ELIGIBLE_OWNER_CAPTIONS: "UNAVAILABLE",
  NOT_CHECKED: "NOT_REQUESTED",
  PENDING: "NOT_REQUESTED",
  FAILED: "ERROR",
};

/** Corpus-level transcript status (never reveals private transcripts) mirrored into the TRANSCRIPT coverage group. */
export async function setTranscriptStatus(videoIds: string[], status: TranscriptStatus, source: string, reason?: string) {
  if (!videoIds.length) return;
  const at = new Date();
  await db.video.updateMany({ where: { id: { in: videoIds } }, data: { transcriptStatus: status } });
  const cov = TRANSCRIPT_COVERAGE[status];
  const rows = videoIds.map(
    (videoId) => Prisma.sql`(${`cov_${videoId}_TRANSCRIPT`}, ${videoId}, 'TRANSCRIPT', ${cov}::"CoverageStatus", ${source}, ${reason ?? status}, ${JSON.stringify({ transcriptStatus: status })}::jsonb,
      ${source.includes("FIXTURE") ? "FIXTURE" : "USER_CONTENT"}::"RetentionClass", ${at}, ${cov === "PRESENT" ? at : null}::timestamp, now())`,
  );
  for (let i = 0; i < rows.length; i += 500) {
    await db.$executeRaw`
      INSERT INTO "FieldCoverage" (id, "videoId", "group", status, source, reason, details, "retentionClass", "lastAttemptAt", "lastSuccessAt", "updatedAt")
      VALUES ${Prisma.join(rows.slice(i, i + 500))}
      ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, source = EXCLUDED.source, reason = EXCLUDED.reason, details = EXCLUDED.details,
        "retentionClass" = EXCLUDED."retentionClass", "lastAttemptAt" = EXCLUDED."lastAttemptAt",
        "lastSuccessAt" = coalesce(EXCLUDED."lastSuccessAt", "FieldCoverage"."lastSuccessAt"), "updatedAt" = now()`;
  }
}

// ── Reads ──────────────────────────────────────────────────────────────────

export interface GroupSummary {
  group: CoverageGroup;
  counts: Partial<Record<CoverageStatus, number>>;
}

export interface CoverageSummary {
  scope: { type: "atlas" | "niche" | "channel"; id?: string; label?: string };
  channels: { total: number; complete: number; groups: GroupSummary[] };
  videos: { total: number; complete: number; withoutCoverage: number; groups: GroupSummary[] };
  history: { states: Record<string, number>; channelsWithMoreHistory: number; pagesScanned: number; itemsSeen: number; unavailable: number };
  derived: { videosEmbedded: number; videosWithTopics: number; channelsClassified: number };
  retention: { expiringSoon: number; overdue: number; nextDeadline: string | null };
  approvals: { pending: number; running: number };
  generatedAt: string;
}

type Filter = { channelIds: string[] | null };

async function groupCounts(kind: "channel" | "video", f: Filter, now: Date): Promise<GroupSummary[]> {
  const lead = new Date(now.getTime() + env.COMPLIANCE_REFRESH_LEAD_DAYS * DAY);
  const where =
    kind === "channel"
      ? f.channelIds
        ? Prisma.sql`fc."channelId" = ANY(${f.channelIds})`
        : Prisma.sql`fc."channelId" IS NOT NULL`
      : f.channelIds
        ? Prisma.sql`fc."videoId" IN (SELECT id FROM "Video" WHERE "channelId" = ANY(${f.channelIds}))`
        : Prisma.sql`fc."videoId" IS NOT NULL`;
  const rows = await db.$queryRaw<{ group: CoverageGroup; status: CoverageStatus; n: number }[]>`
    SELECT fc."group", CASE WHEN fc.status IN ('PRESENT','UNAVAILABLE','NOT_APPLICABLE') AND fc."retentionDeadline" < ${lead} THEN 'STALE' ELSE fc.status::text END AS status, count(*)::int AS n
    FROM "FieldCoverage" fc WHERE ${where} GROUP BY 1, 2`;
  const by = new Map<CoverageGroup, GroupSummary>();
  for (const r of rows) {
    const g = by.get(r.group) ?? { group: r.group, counts: {} };
    g.counts[r.status] = (g.counts[r.status] ?? 0) + r.n;
    by.set(r.group, g);
  }
  return [...by.values()].sort((a, b) => a.group.localeCompare(b.group));
}

async function completeCount(kind: "channel" | "video", f: Filter): Promise<number> {
  const required = kind === "channel" ? REQUIRED_CHANNEL_GROUPS : REQUIRED_VIDEO_GROUPS;
  const col = kind === "channel" ? Prisma.sql`"channelId"` : Prisma.sql`"videoId"`;
  const scope =
    kind === "channel"
      ? f.channelIds ? Prisma.sql`AND "channelId" = ANY(${f.channelIds})` : Prisma.empty
      : f.channelIds ? Prisma.sql`AND "videoId" IN (SELECT id FROM "Video" WHERE "channelId" = ANY(${f.channelIds}))` : Prisma.empty;
  const [r] = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM (
      SELECT ${col} FROM "FieldCoverage"
      WHERE ${col} IS NOT NULL ${scope} AND "group"::text = ANY(${required}) AND status IN ('PRESENT','UNAVAILABLE','NOT_APPLICABLE')
      GROUP BY ${col} HAVING count(DISTINCT "group") = ${required.length}
    ) x`;
  return r?.n ?? 0;
}

async function summarize(scope: CoverageSummary["scope"], f: Filter): Promise<CoverageSummary> {
  const now = new Date();
  const chWhere: Prisma.ChannelWhereInput = f.channelIds ? { id: { in: f.channelIds } } : {};
  const vWhere: Prisma.VideoWhereInput = f.channelIds ? { channelId: { in: f.channelIds } } : {};
  const lead = new Date(now.getTime() + env.COMPLIANCE_REFRESH_LEAD_DAYS * DAY);
  const covScope: Prisma.FieldCoverageWhereInput = f.channelIds ? { OR: [{ channelId: { in: f.channelIds } }, { video: { channelId: { in: f.channelIds } } }] } : {};
  const [channelTotal, videoTotal, chGroups, vGroups, chComplete, vComplete, withoutCov, histories, embedded, withTopics, classified, expiring, overdue, next, pending, running] = await Promise.all([
    db.channel.count({ where: chWhere }),
    db.video.count({ where: vWhere }),
    groupCounts("channel", f, now),
    groupCounts("video", f, now),
    completeCount("channel", f),
    completeCount("video", f),
    db.video.count({ where: { ...vWhere, coverage: { none: {} } } }),
    db.uploadHistory.findMany({ where: f.channelIds ? { channelId: { in: f.channelIds } } : {}, select: { state: true, nextPageToken: true, pagesScanned: true, itemsSeen: true, unavailableCount: true } }),
    db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "Video" WHERE embedding IS NOT NULL ${f.channelIds ? Prisma.sql`AND "channelId" = ANY(${f.channelIds})` : Prisma.empty}`,
    db.video.count({ where: { ...vWhere, topicsAt: { not: null } } }),
    db.channel.count({ where: { ...chWhere, niches: { some: {} } } }),
    db.fieldCoverage.count({ where: { ...covScope, retentionDeadline: { gte: now, lt: lead } } }),
    db.fieldCoverage.count({ where: { ...covScope, retentionDeadline: { lt: now } } }),
    db.fieldCoverage.findFirst({ where: { ...covScope, retentionDeadline: { gte: now } }, orderBy: { retentionDeadline: "asc" }, select: { retentionDeadline: true } }),
    db.expansionProposal.count({ where: { status: "PENDING", ...(f.channelIds ? { targetIds: { hasSome: await youtubeIds(f.channelIds) } } : {}) } }),
    db.expansionProposal.count({ where: { status: { in: ["APPROVED", "RUNNING"] }, ...(f.channelIds ? { targetIds: { hasSome: await youtubeIds(f.channelIds) } } : {}) } }),
  ]);
  const states: Record<string, number> = {};
  for (const h of histories) states[h.state] = (states[h.state] ?? 0) + 1;
  return {
    scope,
    channels: { total: channelTotal, complete: chComplete, groups: chGroups },
    videos: { total: videoTotal, complete: vComplete, withoutCoverage: withoutCov, groups: vGroups },
    history: {
      states,
      channelsWithMoreHistory: histories.filter((h) => h.nextPageToken).length,
      pagesScanned: histories.reduce((a, h) => a + h.pagesScanned, 0),
      itemsSeen: histories.reduce((a, h) => a + h.itemsSeen, 0),
      unavailable: histories.reduce((a, h) => a + h.unavailableCount, 0),
    },
    derived: { videosEmbedded: embedded[0]?.n ?? 0, videosWithTopics: withTopics, channelsClassified: classified },
    retention: { expiringSoon: expiring, overdue, nextDeadline: next?.retentionDeadline?.toISOString() ?? null },
    approvals: { pending, running },
    generatedAt: now.toISOString(),
  };
}

async function youtubeIds(channelIds: string[]): Promise<string[]> {
  return (await db.channel.findMany({ where: { id: { in: channelIds } }, select: { youtubeId: true } })).map((c) => c.youtubeId);
}

export function inspectAtlas() {
  return summarize({ type: "atlas" }, { channelIds: null });
}

export async function inspectNiche(idOrSlug: string) {
  const slug = idOrSlug.replace(/^(sub)?niche:/, "");
  const n = await db.niche.findFirst({ where: { OR: [{ id: idOrSlug }, { slug }] }, select: { id: true, slug: true, name: true, depth: true, children: { select: { id: true } } } });
  if (!n) throw notFound("Niche");
  const nicheIds = n.depth === 0 ? n.children.map((c) => c.id) : [n.id];
  const channelIds = (await db.channelNiche.findMany({ where: { nicheId: { in: nicheIds } }, select: { channelId: true }, distinct: ["channelId"] })).map((c) => c.channelId);
  return summarize({ type: "niche", id: n.id, label: n.name }, { channelIds });
}

const groupView = (rows: { group: CoverageGroup; status: CoverageStatus; source: string; reason: string | null; details: unknown; retentionClass: RetentionClass; lastAttemptAt: Date; lastSuccessAt: Date | null; retentionDeadline: Date | null; error: string | null }[], required: CoverageGroup[], all: CoverageGroup[]) => {
  const now = new Date();
  const by = new Map(rows.map((r) => [r.group, r]));
  return all.map((group) => {
    const r = by.get(group);
    if (!r) return { group, status: "NOT_REQUESTED" as CoverageStatus, required: required.includes(group), reason: "never collected", source: null, details: null, retentionClass: null, lastAttemptAt: null, lastSuccessAt: null, retentionDeadline: null };
    return {
      group,
      status: effectiveStatus(r, now),
      storedStatus: r.status,
      required: required.includes(group),
      reason: r.reason,
      source: r.source,
      details: r.details,
      retentionClass: r.retentionClass,
      lastAttemptAt: r.lastAttemptAt.toISOString(),
      lastSuccessAt: r.lastSuccessAt?.toISOString() ?? null,
      retentionDeadline: r.retentionDeadline?.toISOString() ?? null,
      error: r.error,
    };
  });
};

const VIDEO_GROUPS: CoverageGroup[] = ["IDENTITY", "TEXT", "PUBLICATION", "THUMBNAILS", "STATISTICS", "STATUS", "TRANSCRIPT"];
const CHANNEL_GROUPS: CoverageGroup[] = ["IDENTITY", "TEXT", "CHANNEL_PROFILE", "THUMBNAILS", "STATISTICS", "STATUS"];

export async function inspectChannel(channelId: string) {
  const c = await db.channel.findUnique({ where: { id: channelId }, select: { id: true, youtubeId: true, title: true, videoCount: true, coverage: true, history: true, niches: { select: { nicheId: true } }, embeddingHash: true } });
  if (!c) throw notFound("Channel");
  const groups = groupView(c.coverage, REQUIRED_CHANNEL_GROUPS, CHANNEL_GROUPS);
  const videos = await summarize({ type: "channel", id: c.id, label: c.title }, { channelIds: [c.id] });
  const h = c.history;
  const pending = await db.expansionProposal.findMany({ where: { status: { in: ["PENDING", "APPROVED", "RUNNING"] }, targetIds: { has: c.youtubeId } }, select: { id: true, kind: true, status: true, title: true, createdAt: true } });
  return {
    channelId: c.id,
    youtubeId: c.youtubeId,
    title: c.title,
    complete: groups.filter((g) => g.required).every((g) => RESOLVED_STATUSES.has(g.status as CoverageStatus) || g.status === "STALE"),
    groups,
    history: h && {
      state: h.state,
      pagesScanned: h.pagesScanned,
      itemsSeen: h.itemsSeen,
      videosCollected: h.videosCollected,
      unavailable: h.unavailableCount,
      oldestPublishedAt: h.oldestPublishedAt?.toISOString() ?? null,
      newestPublishedAt: h.newestPublishedAt?.toISOString() ?? null,
      totalResults: h.totalResults,
      reportedVideoCount: c.videoCount,
      remainingEstimate: h.totalResults !== null ? Math.max(0, h.totalResults - h.itemsSeen) : c.videoCount !== null ? Math.max(0, c.videoCount - h.itemsSeen) : null,
      hasMore: Boolean(h.nextPageToken),
      lastPageAt: h.lastPageAt?.toISOString() ?? null,
      completedAt: h.completedAt?.toISOString() ?? null,
      lastError: h.lastError,
    },
    derived: { embedded: Boolean(c.embeddingHash), classified: c.niches.length > 0 },
    videos: { total: videos.videos.total, complete: videos.videos.complete, withoutCoverage: videos.videos.withoutCoverage, groups: videos.videos.groups },
    retention: videos.retention,
    proposals: pending.map((p) => ({ ...p, createdAt: p.createdAt.toISOString() })),
  };
}

export async function inspectVideo(videoId: string) {
  const v = await db.video.findUnique({ where: { id: videoId }, select: { id: true, youtubeId: true, title: true, transcriptStatus: true, topicsAt: true, embeddingHash: true, coverage: true, channelId: true } });
  if (!v) throw notFound("Video");
  const groups = groupView(v.coverage, REQUIRED_VIDEO_GROUPS, VIDEO_GROUPS);
  return {
    videoId: v.id,
    youtubeId: v.youtubeId,
    title: v.title,
    /** Collected = every required group resolved. Transcript is a field-level detail and never required. */
    complete: groups.filter((g) => g.required).every((g) => RESOLVED_STATUSES.has(g.status as CoverageStatus) || g.status === "STALE"),
    groups,
    transcriptStatus: v.transcriptStatus,
    derived: { embedded: Boolean(v.embeddingHash), topicsExtracted: Boolean(v.topicsAt), label: "Atlas-inferred (not YouTube data)" },
  };
}
