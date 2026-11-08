import "dotenv/config";
process.env.ATLAS_PROCESS ??= "worker";

const { env } = await import("@/server/env");
const { baseLogger } = await import("@/server/logger");
const { redis } = await import("@/server/redis");
const { db } = await import("@/server/db");
const { closeQueues } = await import("@/server/jobs");
const { startWorkers } = await import("./processors");
const { registerSchedulers } = await import("./schedulers");
const { startBoard } = await import("./board");

const workers = startWorkers();
if (env.WORKER_SCHEDULERS) await registerSchedulers();
const board = startBoard();
await redis.set(`${env.REDIS_PREFIX}:worker:heartbeat`, String(Date.now()), "EX", 60);
const heartbeat = setInterval(() => void redis.set(`${env.REDIS_PREFIX}:worker:heartbeat`, String(Date.now()), "EX", 60).catch(() => undefined), 20_000);
baseLogger.info({ queues: workers.map((w) => w.name), mode: env.YOUTUBE_MODE }, "worker started");

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  baseLogger.info({ signal }, "worker shutting down (waiting for active jobs)");
  clearInterval(heartbeat);
  board.close();
  await Promise.allSettled(workers.map((w) => w.close()));
  await closeQueues();
  await redis.quit().catch(() => undefined);
  await db.$disconnect().catch(() => undefined);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
