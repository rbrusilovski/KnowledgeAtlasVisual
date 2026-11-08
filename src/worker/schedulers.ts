import { getQueue, QUEUES } from "@/server/jobs";
import { QUOTA_TIMEZONE } from "@/server/youtube/costs";

/** Recurring jobs via BullMQ Job Schedulers (idempotent upserts on every boot). */
export async function registerSchedulers() {
  await getQueue(QUEUES.scheduler).upsertJobScheduler("sync-due", { every: 15 * 60_000 }, { name: "scheduler", data: { task: "sync" } });
  await getQueue(QUEUES.scheduler).upsertJobScheduler("stats-refresh", { every: 60 * 60_000 }, { name: "scheduler", data: { task: "stats" } });
  await getQueue(QUEUES.compliance).upsertJobScheduler("compliance-daily", { pattern: "0 3 * * *", tz: QUOTA_TIMEZONE }, { name: "compliance", data: {} });
}
