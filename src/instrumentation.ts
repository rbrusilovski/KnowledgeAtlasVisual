/** Next.js instrumentation hook: warm the query-embedding model and register health checks (Node runtime only). */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { warmup, embeddingStatus } = await import("@/server/services/embeddings");
  const { registerHealthCheck } = await import("@/server/health");
  const { queueCounts } = await import("@/server/jobs");
  const { redis } = await import("@/server/redis");
  const { env } = await import("@/server/env");
  warmup();
  registerHealthCheck("embeddings", embeddingStatus);
  registerHealthCheck("queues", async () => {
    const counts = await queueCounts();
    const waiting = Object.values(counts).reduce((s, c) => s + (c.waiting ?? 0) + (c.prioritized ?? 0), 0);
    const failed = Object.values(counts).reduce((s, c) => s + (c.failed ?? 0), 0);
    const beat = await redis.get(`${env.REDIS_PREFIX}:worker:heartbeat`);
    const lagMs = beat ? Date.now() - Number(beat) : null;
    if (lagMs === null || lagMs > 90_000) throw new Error(`worker heartbeat missing (waiting=${waiting})`);
    return `waiting=${waiting} failed=${failed} worker=${Math.round(lagMs / 1000)}s ago`;
  });
}
