import { db } from "./db";
import { redis } from "./redis";
import { env } from "./env";

type Check = { ok: boolean; ms: number; detail?: string };

async function timed(fn: () => Promise<string | void>): Promise<Check> {
  const t = performance.now();
  try {
    const detail = (await fn()) ?? undefined;
    return { ok: true, ms: Math.round(performance.now() - t), detail };
  } catch (e) {
    return { ok: false, ms: Math.round(performance.now() - t), detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Extra checks registered by services (queues, embeddings) to avoid import cycles. */
const extraChecks = new Map<string, () => Promise<string | void>>();
export function registerHealthCheck(name: string, fn: () => Promise<string | void>) {
  extraChecks.set(name, fn);
}

export async function healthReport() {
  const checks: Record<string, Check> = {
    database: await timed(async () => {
      const r = await db.$queryRaw<{ v: string }[]>`SELECT extversion AS v FROM pg_extension WHERE extname = 'vector'`;
      if (!r[0]) throw new Error("pgvector extension missing");
      return `pgvector ${r[0].v}`;
    }),
    redis: await timed(async () => {
      const pong = await redis.ping();
      if (pong !== "PONG") throw new Error(pong);
    }),
  };
  for (const [name, fn] of extraChecks) checks[name] = await timed(fn);
  return { ok: Object.values(checks).every((c) => c.ok), mode: env.YOUTUBE_MODE, checks, time: new Date().toISOString() };
}
