/**
 * Operational alert registry (deferred findings D6 + D12). Each check is cheap, read-only and independent; the
 * result is shown on /admin, summarized in /api/health, and emitted as structured `alert` log events by the
 * scheduler (only on change), so a log-based pager can pick them up.
 */
import { db } from "@/server/db";
import { env } from "@/server/env";
import { redis, key } from "@/server/redis";
import { log } from "@/server/logger";
import { getQueue, QUEUES } from "@/server/jobs";
import { usage } from "@/server/services/quota";
import { embeddingSpace } from "@/server/services/embeddings";

export type AlertSeverity = "critical" | "warning" | "info";
export interface Alert {
  id: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
  /** Suggested recovery action. */
  action?: string;
  since?: string | null;
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** Development / fixture deployments: backup and restore-test checks are informational. */
const relaxed = () => env.NODE_ENV !== "production";

type Check = () => Promise<Alert[]>;

const workerDown: Check = async () => {
  const hb = await redis.get(`${env.REDIS_PREFIX}:worker:heartbeat`);
  if (hb) return [];
  return [{ id: "worker-down", severity: "critical", title: "Worker is not running", detail: "No worker heartbeat in the last 60 s: ingestion, approvals, compliance deletion and graph builds are paused.", action: "Start `pnpm worker` (or the worker container) and check its logs." }];
};

const queueBacklog: Check = async () => {
  const out: Alert[] = [];
  let failed = 0;
  const failedByQueue: string[] = [];
  let oldestWaiting = 0;
  for (const name of Object.values(QUEUES)) {
    const q = getQueue(name);
    const c = await q.getJobCounts("failed");
    if (c.failed) {
      failed += c.failed;
      failedByQueue.push(`${name}: ${c.failed}`);
    }
    const [w] = await q.getWaiting(0, 0);
    if (w) oldestWaiting = Math.max(oldestWaiting, Date.now() - w.timestamp);
  }
  if (failed >= 25) out.push({ id: "failed-jobs", severity: failed >= 200 ? "critical" : "warning", title: `${failed} failed jobs`, detail: failedByQueue.join(" · "), action: "Inspect /admin → Failed jobs; `pnpm jobs:recover --retry-failed --apply` after fixing the cause." });
  if (oldestWaiting > 15 * 60_000) out.push({ id: "queue-lag", severity: oldestWaiting > HOUR ? "critical" : "warning", title: "Queue lag", detail: `Oldest waiting job has waited ${Math.round(oldestWaiting / 60_000)} min.`, action: "Check worker health and concurrency." });
  const embedFailed = (await getQueue(QUEUES.embed).getJobCounts("failed")).failed ?? 0;
  if (embedFailed) out.push({ id: "embedding-failures", severity: "warning", title: `${embedFailed} failed embedding job(s)`, detail: "Semantic search and SIMILAR edges miss the affected rows.", action: "Check the embedding provider; `pnpm embeddings:reindex` fills missing vectors." });
  return out;
};

const upstreamErrors: Check = async () => {
  const since = new Date(Date.now() - HOUR);
  const rows = await db.ingestionRun.findMany({ where: { status: "failed", startedAt: { gte: since } }, select: { error: true } });
  const upstream = rows.filter((r) => /youtube|upstream|5\d\d|network|timeout|quota/i.test(r.error ?? ""));
  if (upstream.length < 5) return [];
  return [{ id: "upstream-errors", severity: upstream.length >= 20 ? "critical" : "warning", title: `${upstream.length} upstream failures in the last hour`, detail: (upstream[0]?.error ?? "").slice(0, 200), action: "Check YouTube API status and quota; retries back off automatically." }];
};

const quota: Check = async () => {
  const u = await usage();
  return u.buckets
    .filter((b) => b.exhausted || b.used >= b.limit)
    .map((b) => ({ id: `quota-${b.bucket}`, severity: "warning" as const, title: `YouTube ${b.bucket} quota exhausted`, detail: `${b.used}/${b.limit} used; background work is delayed until the reset at ${u.resetAt}.`, action: "Wait for the Pacific-midnight reset; approvals keep their scope." }));
};

const oauth: Check = async () => {
  const n = await db.youTubeConnection.count({ where: { lastRefreshError: { not: null } } });
  if (!n) return [];
  return [{ id: "oauth-refresh", severity: "warning", title: `${n} YouTube connection(s) failing to refresh`, detail: "Owner captions obtained through these connections are purged by the compliance job.", action: "Ask the affected users to reconnect YouTube in Settings." }];
};

const embeddings: Check = async () => {
  const s = await embeddingSpace();
  if (!s.blocked) return [];
  return [{ id: "embedding-space", severity: "critical", title: "Embedding vector space is inconsistent", detail: s.reason ?? "", action: "Run `pnpm embeddings:reindex`, then `pnpm graph:rebuild`." }];
};

const retention: Check = async () => {
  const now = new Date();
  const lead = new Date(now.getTime() + env.COMPLIANCE_REFRESH_LEAD_DAYS * DAY);
  const [expiring, overdue, refreshProposals] = await Promise.all([
    db.fieldCoverage.count({ where: { retentionDeadline: { gte: now, lt: lead }, retentionClass: { in: ["API_METADATA", "API_STATISTICS", "AUTHORIZED_DATA"] } } }),
    db.fieldCoverage.count({ where: { retentionDeadline: { lt: now }, retentionClass: { in: ["API_METADATA", "API_STATISTICS", "AUTHORIZED_DATA"] } } }),
    db.expansionProposal.count({ where: { kind: "REFRESH_METADATA", status: { in: ["PENDING", "APPROVED", "RUNNING"] } } }),
  ]);
  const out: Alert[] = [];
  if (overdue) out.push({ id: "retention-overdue", severity: "critical", title: `${overdue} API-data field group(s) past their retention deadline`, detail: "They must be refreshed or deleted now; the daily compliance job deletes them.", action: "Check the compliance job ran (worker up, schedulers on)." });
  if (expiring) out.push({ id: "retention-expiring", severity: refreshProposals ? "info" : "warning", title: `${expiring} field group(s) reach their retention deadline within ${env.COMPLIANCE_REFRESH_LEAD_DAYS} days`, detail: refreshProposals ? `${refreshProposals} refresh proposal(s) pending/approved.` : "No refresh proposal is pending — the data will be deleted at its deadline.", action: "Review compliance refresh proposals on /data." });
  return out;
};

const graph: Check = async () => {
  const since = await redis.get(key("graph", "dirty-since"));
  if (!since) return [];
  const age = Date.now() - Number(since);
  if (age < 10 * 60_000) return [];
  return [{ id: "graph-stale", severity: age > HOUR ? "critical" : "warning", title: "Graph materialization is stale", detail: `${await redis.scard(key("graph", "dirty"))} node(s) dirty for ${Math.round(age / 60_000)} min.`, action: "`pnpm jobs:recover --apply` re-enqueues the build; `pnpm graph:verify --repair` checks consistency.", since: new Date(Number(since)).toISOString() }];
};

const backups: Check = async () => {
  const [ok, fail, restore] = await Promise.all([redis.get(key("ops", "backup", "last-success")), redis.get(key("ops", "backup", "last-failure")), redis.get(key("ops", "restore-test", "last-success"))]);
  const sev = (s: AlertSeverity): AlertSeverity => (relaxed() ? "info" : s);
  const okAt = ok ? Date.parse((JSON.parse(ok) as { at: string }).at) : 0;
  const failAt = fail ? Date.parse((JSON.parse(fail) as { at: string }).at) : 0;
  const out: Alert[] = [];
  if (failAt > okAt) out.push({ id: "backup-failed", severity: sev("critical"), title: "Last database backup failed", detail: (JSON.parse(fail!) as { error?: string }).error ?? "", action: "Run `pnpm db:backup` and fix the reported error." });
  else if (!okAt) out.push({ id: "backup-missing", severity: sev("warning"), title: "No database backup recorded", detail: "Persistent volumes are not a backup.", action: "Schedule `pnpm db:backup` (docs/OPERATIONS.md)." });
  else if (Date.now() - okAt > 26 * HOUR) out.push({ id: "backup-stale", severity: sev("warning"), title: "Database backup is older than 26 h", detail: `Last success ${new Date(okAt).toISOString()}.`, action: "Check the backup schedule." });
  if (ok && !(JSON.parse(ok) as { offHost?: boolean }).offHost) out.push({ id: "backup-on-host", severity: sev("warning"), title: "Backups are not copied off-host", detail: "BACKUP_UPLOAD_CMD is not configured.", action: "Set BACKUP_UPLOAD_CMD (docs/OPERATIONS.md)." });
  const restoreAt = restore ? Date.parse((JSON.parse(restore) as { at: string }).at) : 0;
  if (Date.now() - restoreAt > 8 * DAY) out.push({ id: "restore-untested", severity: sev("warning"), title: restoreAt ? "Restore test is older than 8 days" : "Backups have never been restore-tested", detail: "An untested backup is not a backup.", action: "Run `pnpm db:restore-test` weekly." });
  return out;
};

const CHECKS: Record<string, Check> = { workerDown, queueBacklog, upstreamErrors, quota, oauth, embeddings, retention, graph, backups };
const ORDER: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };

export async function evaluateAlerts(): Promise<Alert[]> {
  const out: Alert[] = [];
  for (const [name, check] of Object.entries(CHECKS)) {
    try {
      out.push(...(await check()));
    } catch (err) {
      out.push({ id: `check-${name}`, severity: "warning", title: `Alert check "${name}" failed`, detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return out.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.id.localeCompare(b.id));
}

/** Scheduler task: log `alert` events for alerts that appeared, changed severity or cleared. */
export async function emitAlertEvents(): Promise<{ active: number; changed: number }> {
  const alerts = await evaluateAlerts();
  const k = key("alerts", "active");
  const prev = (await redis.hgetall(k)) ?? {};
  const now: Record<string, string> = Object.fromEntries(alerts.map((a) => [a.id, a.severity]));
  let changed = 0;
  for (const a of alerts) {
    if (prev[a.id] === a.severity) continue;
    changed++;
    const entry = { alert: a.id, severity: a.severity, title: a.title, detail: a.detail, action: a.action };
    if (a.severity === "critical") log().error(entry, "alert");
    else if (a.severity === "warning") log().warn(entry, "alert");
    else log().info(entry, "alert");
  }
  for (const id of Object.keys(prev)) {
    if (now[id]) continue;
    changed++;
    log().info({ alert: id, severity: "resolved" }, "alert");
  }
  const pipe = redis.multi().del(k);
  if (alerts.length) pipe.hset(k, now);
  await pipe.exec();
  return { active: alerts.length, changed };
}
