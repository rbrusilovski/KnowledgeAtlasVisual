/**
 * Compliance lifecycle (Developer Policies III.E.4, III.D.2; docs/COMPLIANCE_DECISIONS.md). Daily job:
 *
 *  1. DELETE — never gated by approval, quota or policy flags:
 *     • channel/video records whose identity/text metadata passed its retention deadline (derived data cascades);
 *     • statistics past their deadline on otherwise-fresh records (values cleared, group marked EXPIRED);
 *     • owner-caption transcripts older than 30 days, and all data of connections whose token can't be refreshed;
 *     • topics no longer referenced by any video.
 *  2. PROPOSE REFRESH — records entering the refresh lead window become ONE pending SYSTEM REFRESH_METADATA proposal
 *     (expires at the earliest deadline). Refreshing is collection, so it needs an admin's approval; if nobody
 *     approves, step 1 deletes the data at its deadline.
 *
 * Fixed vs the previous job: quota shortfalls no longer delete data early (deletion happens only at the deadline),
 * transient API errors no longer abort the run, and freshness is tracked per field group so a partial refresh can
 * never extend retention of fields it did not re-fetch.
 */
import { db, type Prisma } from "@/server/db";
import { env } from "@/server/env";
import { log } from "@/server/logger";
import { enqueue } from "@/server/jobs";
import { policyAllows } from "@/server/youtube";
import { createProposal } from "@/server/services/expansion";
import { API_RETENTION_DAYS } from "@/server/services/coverage";

const DAY = 86_400_000;
const BATCH = 1_000;
/** Groups whose expiry makes the whole record unusable → delete the record. */
const RECORD_GROUPS = ["IDENTITY", "TEXT"] as const;

export interface ComplianceReport {
  channels: { deleted: number; statsExpired: number };
  videos: { deleted: number; statsExpired: number };
  transcripts: { authorizedExpired: number; connectionsPurged: number };
  topicsPruned: number;
  refresh: { channels: number; videos: number; proposalId: string | null; skipped?: string; earliestDeadline: string | null };
}

export async function runCompliance(now = new Date()): Promise<ComplianceReport> {
  const report: ComplianceReport = {
    channels: { deleted: 0, statsExpired: 0 },
    videos: { deleted: 0, statsExpired: 0 },
    transcripts: { authorizedExpired: 0, connectionsPurged: 0 },
    topicsPruned: 0,
    refresh: { channels: 0, videos: 0, proposalId: null, earliestDeadline: null },
  };
  const dirty = new Set<string>();

  // ── 1a. Records past their metadata deadline ──
  const legacyCutoff = new Date(now.getTime() - API_RETENTION_DAYS * DAY);
  for (;;) {
    const rows = await db.video.findMany({
      where: { OR: [{ coverage: { some: { group: { in: [...RECORD_GROUPS] }, retentionDeadline: { lt: now } } } }, { coverage: { none: {} }, OR: [{ lastRefreshedAt: null }, { lastRefreshedAt: { lt: legacyCutoff } }] }] },
      select: { id: true, youtubeId: true, channel: { select: { youtubeId: true } } },
      take: BATCH,
    });
    if (!rows.length) break;
    await db.video.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    rows.forEach((r) => (dirty.add(`video:${r.youtubeId}`), dirty.add(`channel:${r.channel.youtubeId}`)));
    report.videos.deleted += rows.length;
    if (rows.length < BATCH) break;
  }
  for (;;) {
    const rows = await db.channel.findMany({
      where: { OR: [{ coverage: { some: { group: { in: [...RECORD_GROUPS] }, retentionDeadline: { lt: now } } } }, { coverage: { none: {} }, OR: [{ lastRefreshedAt: null }, { lastRefreshedAt: { lt: legacyCutoff } }] }] },
      select: { id: true, youtubeId: true },
      take: BATCH,
    });
    if (!rows.length) break;
    await db.channel.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } }); // videos, transcripts, coverage, history cascade
    rows.forEach((r) => dirty.add(`channel:${r.youtubeId}`));
    report.channels.deleted += rows.length;
    if (rows.length < BATCH) break;
  }

  // ── 1b. Statistics past their deadline (record otherwise fresh) ──
  const expiredStats = await db.fieldCoverage.findMany({ where: { group: "STATISTICS", retentionDeadline: { lt: now }, status: { not: "EXPIRED" } }, select: { id: true, channelId: true, videoId: true } });
  for (let i = 0; i < expiredStats.length; i += BATCH) {
    const b = expiredStats.slice(i, i + BATCH);
    const vids = b.flatMap((r) => (r.videoId ? [r.videoId] : []));
    const chs = b.flatMap((r) => (r.channelId ? [r.channelId] : []));
    await db.$transaction([
      db.video.updateMany({ where: { id: { in: vids } }, data: { viewCount: null, likeCount: null, commentCount: null } }),
      db.channel.updateMany({ where: { id: { in: chs } }, data: { subscriberCount: null, viewCount: null, videoCount: null } }),
      db.fieldCoverage.updateMany({ where: { id: { in: b.map((r) => r.id) } }, data: { status: "EXPIRED", reason: "retention deadline passed without an approved refresh; values deleted" } }),
    ]);
    report.videos.statsExpired += vids.length;
    report.channels.statsExpired += chs.length;
  }

  // ── 1c. Authorized data ──
  const authorizedCutoff = new Date(now.getTime() - API_RETENTION_DAYS * DAY);
  report.transcripts.authorizedExpired = (await db.transcript.deleteMany({ where: { source: "OWNER_CAPTIONS", fetchedAt: { lt: authorizedCutoff } } })).count;
  const broken = await db.youTubeConnection.findMany({ where: { lastRefreshError: { not: null } }, select: { id: true, userId: true } });
  for (const c of broken) {
    await db.transcript.deleteMany({ where: { connectionId: c.id } });
    await db.youTubeConnection.delete({ where: { id: c.id } });
    report.transcripts.connectionsPurged++;
  }

  // ── 1d. Orphaned derived topics ──
  const orphans = await db.$queryRaw<{ id: string; slug: string }[]>`SELECT t.id, t.slug FROM "Topic" t WHERE NOT EXISTS (SELECT 1 FROM "VideoTopic" vt WHERE vt."topicId" = t.id) LIMIT 10000`;
  if (orphans.length) {
    await db.topic.deleteMany({ where: { id: { in: orphans.map((o) => o.id) } } });
    orphans.forEach((o) => dirty.add(`topic:${o.slug}`));
    report.topicsPruned = orphans.length;
  }
  if (report.videos.deleted || report.channels.deleted) await recomputeTopicCountsAll();

  // ── 2. Refresh proposal for data entering the lead window ──
  report.refresh = await proposeComplianceRefresh(now);

  if (dirty.size) await enqueue.graph([...dirty]);
  log().info(report, "compliance run finished");
  return report;
}

async function recomputeTopicCountsAll() {
  await db.$executeRaw`
    UPDATE "Topic" t SET "videoCount" = x.v, "channelCount" = x.c FROM (
      SELECT vt."topicId", count(DISTINCT vt."videoId")::int v, count(DISTINCT v."channelId")::int c
      FROM "VideoTopic" vt JOIN "Video" v ON v.id = vt."videoId" GROUP BY vt."topicId") x
    WHERE x."topicId" = t.id AND (t."videoCount" <> x.v OR t."channelCount" <> x.c)`;
}

/** Max records in one compliance refresh proposal (50k videos ≈ 1,000 units). */
const MAX_REFRESH_VIDEOS = 50_000;

export async function proposeComplianceRefresh(now = new Date()): Promise<ComplianceReport["refresh"]> {
  const lead = new Date(now.getTime() + env.COMPLIANCE_REFRESH_LEAD_DAYS * DAY);
  const base = { channels: 0, videos: 0, proposalId: null as string | null, earliestDeadline: null as string | null };
  if (!policyAllows("live-collection")) return { ...base, skipped: "live collection disabled — data will be deleted at its deadline" };
  const active = await db.expansionProposal.findFirst({ where: { source: "SYSTEM", kind: "REFRESH_METADATA", status: { in: ["PENDING", "APPROVED", "RUNNING"] }, scope: { path: ["purpose"], equals: "compliance" } }, select: { id: true } });
  if (active) return { ...base, proposalId: active.id, skipped: "a compliance refresh proposal is already pending or running" };
  const due = { retentionDeadline: { gte: now, lt: lead }, group: { in: ["IDENTITY", "TEXT", "STATISTICS"] as ("IDENTITY" | "TEXT" | "STATISTICS")[] } } satisfies Prisma.FieldCoverageWhereInput;
  const [channels, videos, earliest] = await Promise.all([
    db.channel.findMany({ where: { coverage: { some: due } }, select: { youtubeId: true }, take: 5_000 }),
    db.video.findMany({ where: { coverage: { some: due } }, select: { youtubeId: true }, orderBy: { lastRefreshedAt: { sort: "asc", nulls: "first" } }, take: MAX_REFRESH_VIDEOS }),
    db.fieldCoverage.findFirst({ where: due, orderBy: { retentionDeadline: "asc" }, select: { retentionDeadline: true } }),
  ]);
  if (!channels.length && !videos.length) return base;
  const deadline = earliest?.retentionDeadline ?? lead;
  const p = await createProposal(
    {
      scope: { kind: "REFRESH_METADATA", channelYoutubeIds: channels.map((c) => c.youtubeId), videoYoutubeIds: videos.map((v) => v.youtubeId), fields: "all", purpose: "compliance" },
      reason: `YouTube API data must be refreshed or deleted within ${API_RETENTION_DAYS} days. ${channels.length} channel(s) and ${videos.length} video(s) reach that limit by ${lead.toISOString().slice(0, 10)}.`,
      coverageGap: `If this is not approved and executed before ${deadline.toISOString()}, the affected data is deleted automatically.`,
      title: `Compliance refresh: ${channels.length} channel(s), ${videos.length} video(s)`,
      expiresAt: new Date(Math.max(now.getTime() + 3_600_000, deadline.getTime() - 3_600_000)),
    },
    { kind: "system" },
  );
  return { channels: channels.length, videos: videos.length, proposalId: p.id, earliestDeadline: deadline.toISOString() };
}
