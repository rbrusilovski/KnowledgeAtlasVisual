import type { Worker } from "bullmq";
import { db } from "@/server/db";
import { redis, key } from "@/server/redis";
import { getQueue, QUEUES, closeQueues, type QueueName } from "@/server/jobs";
import type { JobControl } from "@/server/services/ingestion";

export const noopCtl: JobControl = { jobId: "test", progress: async () => {} };

export async function resetDb() {
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  for (let attempt = 0; ; attempt++) {
    try {
      await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
      return;
    } catch (e) {
      // A straggling in-process job can hold row locks; back off and retry.
      if (attempt >= 5 || !String(e).includes("deadlock")) throw e;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
}

export async function flushRedis() {
  const stream = redis.scanStream({ match: `${key("")}*`, count: 500 });
  for await (const keys of stream as AsyncIterable<string[]>) if (keys.length) await redis.del(...keys);
  const bull = redis.scanStream({ match: `${process.env.REDIS_PREFIX}-bull:*`, count: 500 });
  for await (const keys of bull as AsyncIterable<string[]>) if (keys.length) await redis.del(...keys);
}

let served: QueueName[] = Object.values(QUEUES);
/** Queues that have an in-process worker in this test file (others are not drained). */
export function setServed(workers: Worker[]) {
  served = workers.map((w) => w.name as QueueName).filter((q) => q !== "scheduler" && q !== "compliance");
}

/** Wait until every served queue has nothing waiting/active/delayed-soon. */
export async function drain(timeoutMs = 120_000, queues: QueueName[] = served) {
  const t0 = Date.now();
  let quiet = 0;
  while (Date.now() - t0 < timeoutMs) {
    let busy = 0;
    for (const q of queues) {
      const c = await getQueue(q).getJobCounts("waiting", "active", "prioritized", "delayed");
      busy += (c.waiting ?? 0) + (c.active ?? 0) + (c.prioritized ?? 0);
      // Short (debounce) delays count as busy; long (quota) delays don't.
      const delayed = await getQueue(q).getDelayed(0, 50);
      busy += delayed.filter((j) => j.timestamp + (j.opts.delay ?? 0) - Date.now() < 30_000).length;
    }
    quiet = busy === 0 ? quiet + 1 : 0;
    if (quiet >= 3) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("queues did not drain in time");
}

export async function stopWorkers(workers: Worker[]) {
  await Promise.all(workers.map((w) => w.close(true)));
  await closeQueues();
}

export async function teardown(workers: Worker[] = []) {
  await stopWorkers(workers);
  await redis.quit();
  await db.$disconnect();
}

export const FIXTURE_CHANNEL = "UCSkce29rCKQIIQVOKKuihmk"; // "Ember Dev" (ai-ml)
