/**
 * pnpm jobs:recover [--apply] [--retry-failed] — recover from crashed or partially completed work (D5).
 *
 *  • IngestionRuns stuck in "running" whose BullMQ job is gone or no longer active → marked failed ("abandoned")
 *  • RUNNING proposals whose registered jobs no longer exist in any queue → those jobs recorded as failed, so the
 *    proposal finalizes instead of hanging (approval scope is untouched; nothing is re-authorized)
 *  • a non-empty graph dirty set with no pending graph-build → a build is enqueued
 *  • --retry-failed: failed BullMQ jobs are retried; workers re-check their approval before writing anything
 * Without --apply it only reports what it would do.
 */
import "dotenv/config";

const { db } = await import("@/server/db");
const { redis, key } = await import("@/server/redis");
const { closeQueues, findJob, getQueue, QUEUES, enqueue } = await import("@/server/jobs");
const { completeJob } = await import("@/server/services/expansion");

const apply = process.argv.includes("--apply");
const retryFailed = process.argv.includes("--retry-failed");
const STALE_RUN_MS = Number(process.env.RECOVER_STALE_RUN_MINUTES ?? 120) * 60_000;
const report = { staleRuns: 0, lostProposalJobs: 0, graphBuildEnqueued: false, failedRetried: 0, failedFound: 0 };

try {
  // 1. Abandoned ingestion runs.
  const running = await db.ingestionRun.findMany({ where: { status: "running", startedAt: { lt: new Date(Date.now() - STALE_RUN_MS) } }, select: { id: true, jobId: true, kind: true, targetId: true } });
  for (const r of running) {
    const job = r.jobId ? await findJob(r.jobId) : null;
    const state = job ? await job.job.getState() : "missing";
    if (state === "active" || state === "waiting" || state === "delayed" || state === "prioritized") continue;
    report.staleRuns++;
    console.log(`[recover] run ${r.id} (${r.kind} ${r.targetId}) stuck in running; job ${r.jobId ?? "-"} is ${state}`);
    if (apply) await db.ingestionRun.update({ where: { id: r.id }, data: { status: "failed", finishedAt: new Date(), error: `abandoned: job ${state} (recovered by jobs:recover)` } });
  }

  // 2. RUNNING proposals with lost jobs.
  const proposals = await db.expansionProposal.findMany({ where: { status: "RUNNING" }, select: { id: true, jobIds: true, doneJobIds: true, failedJobIds: true } });
  for (const p of proposals) {
    for (const jobId of p.jobIds.filter((j) => !p.doneJobIds.includes(j) && !p.failedJobIds.includes(j))) {
      if (await findJob(jobId)) continue;
      report.lostProposalJobs++;
      console.log(`[recover] proposal ${p.id}: job ${jobId} no longer exists in any queue`);
      if (apply) await completeJob(p.id, jobId, { ok: false, error: "job lost (queue data missing); recorded by jobs:recover" });
    }
  }

  // 3. Stuck graph dirty set.
  const dirty = await redis.scard(key("graph", "dirty"));
  if (dirty) {
    const g = getQueue(QUEUES.graph);
    const c = await g.getJobCounts("waiting", "active", "delayed", "prioritized");
    if (!Object.values(c).some(Boolean)) {
      report.graphBuildEnqueued = true;
      console.log(`[recover] ${dirty} dirty graph node(s) with no pending graph-build`);
      if (apply) await enqueue.graph([]);
    }
  }

  // 4. Failed jobs.
  for (const name of Object.values(QUEUES)) {
    const failed = await getQueue(name).getFailed(0, 999);
    report.failedFound += failed.length;
    if (!retryFailed) continue;
    for (const j of failed) {
      if (apply) await j.retry("failed");
      report.failedRetried++;
    }
  }
  console.log(`[recover] ${apply ? "applied" : "dry run (use --apply)"}:`, report);
} finally {
  await closeQueues();
  await redis.quit();
  await db.$disconnect();
}
process.exit(0);
