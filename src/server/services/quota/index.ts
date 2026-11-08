import { redis, key } from "@/server/redis";
import { env } from "@/server/env";
import { bucketLimits, type QuotaBucket, type YouTubeMethod } from "@/server/youtube/costs";
import { quotaDay, nextResetAt, secondsUntilReset } from "./time";
import { AppError } from "@/server/errors";

export { quotaDay, nextResetAt, secondsUntilReset } from "./time";

export type Lane = "interactive" | "background";
export type DenyReason = "exhausted" | "background_budget" | "insufficient";

export interface ReserveResult {
  ok: boolean;
  used: number;
  limit: number;
  reason?: DenyReason;
  resetAt: Date;
}

/**
 * Atomic check-and-increment. KEYS: usage, exhausted-flag. ARGV: cost, limit, lane, bgRatio, ttlSec.
 * Returns {ok(1|0), used, reasonCode(0 ok, 1 exhausted, 2 background_budget, 3 insufficient)}.
 */
const RESERVE = `
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local cost = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
if redis.call('EXISTS', KEYS[2]) == 1 then return {0, used, 1} end
if ARGV[3] == 'background' and (used + cost) > math.floor(limit * tonumber(ARGV[4])) then return {0, used, 2} end
if (used + cost) > limit then
  if used >= limit then return {0, used, 1} end
  return {0, used, 3}
end
used = redis.call('INCRBY', KEYS[1], cost)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[5]))
return {1, used, 0}
`;

const REASONS: (DenyReason | undefined)[] = [undefined, "exhausted", "background_budget", "insufficient"];

const usageKey = (bucket: QuotaBucket, day = quotaDay()) => key("quota", bucket, day);
const exhaustedKey = (bucket: QuotaBucket, day = quotaDay()) => key("quota", bucket, day, "exhausted");
const tallyKey = (day = quotaDay()) => key("quota", "tally", day);
const KEEP_SEC = 8 * 24 * 3600; // keep a week of history for /admin

export async function reserve(bucket: QuotaBucket, cost: number, lane: Lane): Promise<ReserveResult> {
  const limit = bucketLimits()[bucket];
  const [ok, used, code] = (await redis.eval(
    RESERVE,
    2,
    usageKey(bucket),
    exhaustedKey(bucket),
    cost,
    limit,
    lane,
    env.QUOTA_BACKGROUND_RATIO,
    KEEP_SEC,
  )) as [number, number, number];
  return { ok: ok === 1, used, limit, reason: REASONS[code], resetAt: nextResetAt() };
}

/** Peek without spending: would a `lane` call of `cost` units be allowed right now? */
export async function canSpend(bucket: QuotaBucket, cost: number, lane: Lane): Promise<boolean> {
  const limit = bucketLimits()[bucket];
  const [usedStr, exhausted] = await Promise.all([redis.get(usageKey(bucket)), redis.exists(exhaustedKey(bucket))]);
  const used = Number(usedStr ?? 0);
  if (exhausted) return false;
  const cap = lane === "background" ? Math.floor(limit * env.QUOTA_BACKGROUND_RATIO) : limit;
  return used + cost <= cap;
}

/** Called on a real 403 quotaExceeded: bucket is dead until the Pacific-midnight reset. */
export async function markExhausted(bucket: QuotaBucket): Promise<Date> {
  const resetAt = nextResetAt();
  await redis.set(exhaustedKey(bucket), "1", "EX", secondsUntilReset());
  await redis.set(usageKey(bucket), String(bucketLimits()[bucket]), "EX", KEEP_SEC);
  return resetAt;
}

export async function isExhausted(bucket: QuotaBucket): Promise<boolean> {
  return (await redis.exists(exhaustedKey(bucket))) === 1;
}

export async function recordCall(method: YouTubeMethod, bucket: QuotaBucket, units: number) {
  const k = tallyKey();
  await redis.multi().hincrby(k, `${bucket}:${method}:calls`, 1).hincrby(k, `${bucket}:${method}:units`, units).expire(k, KEEP_SEC).exec();
}

export interface BucketUsage {
  bucket: QuotaBucket;
  used: number;
  limit: number;
  remaining: number;
  backgroundCap: number;
  exhausted: boolean;
}

export interface QuotaUsage {
  day: string;
  resetAt: string;
  buckets: BucketUsage[];
  methods: { bucket: string; method: string; calls: number; units: number }[];
}

export async function usage(day = quotaDay()): Promise<QuotaUsage> {
  const limits = bucketLimits();
  const buckets: BucketUsage[] = [];
  for (const bucket of Object.keys(limits) as QuotaBucket[]) {
    const [u, ex] = await Promise.all([redis.get(usageKey(bucket, day)), redis.exists(exhaustedKey(bucket, day))]);
    const used = Number(u ?? 0);
    buckets.push({
      bucket,
      used,
      limit: limits[bucket],
      remaining: Math.max(0, limits[bucket] - used),
      backgroundCap: Math.floor(limits[bucket] * env.QUOTA_BACKGROUND_RATIO),
      exhausted: ex === 1,
    });
  }
  const tally = await redis.hgetall(tallyKey(day));
  const methods = new Map<string, { bucket: string; method: string; calls: number; units: number }>();
  for (const [field, v] of Object.entries(tally)) {
    const [bucket, method, metric] = field.split(":") as [string, string, "calls" | "units"];
    const m = methods.get(`${bucket}:${method}`) ?? { bucket, method, calls: 0, units: 0 };
    m[metric] = Number(v);
    methods.set(`${bucket}:${method}`, m);
  }
  return { day, resetAt: nextResetAt().toISOString(), buckets, methods: [...methods.values()] };
}

/** History for the admin page (last N Pacific days). */
export async function history(days = 7) {
  const out: QuotaUsage[] = [];
  const now = Date.now();
  for (let i = 0; i < days; i++) out.push(await usage(quotaDay(new Date(now - i * 86_400_000))));
  return out;
}

// ── Per-user discovery fairness ────────────────────────────────────────────

export async function reserveUserDiscovery(userId: string, searches: number): Promise<{ used: number; cap: number }> {
  const cap = env.DISCOVERY_SEARCHES_PER_USER_PER_DAY;
  const k = key("quota", "user-discovery", userId, quotaDay());
  const used = await redis.incrby(k, searches);
  await redis.expire(k, 2 * 86400);
  if (used > cap) {
    await redis.decrby(k, searches);
    throw new AppError(
      "QUOTA_EXHAUSTED",
      `Daily discovery limit reached (${cap} searches/day). Resets at midnight Pacific.`,
      { scope: "user", cap, used: used - searches, resetAt: nextResetAt().toISOString() },
      { "Retry-After": String(secondsUntilReset()) },
    );
  }
  return { used, cap };
}

export async function refundUserDiscovery(userId: string, searches: number) {
  await redis.decrby(key("quota", "user-discovery", userId, quotaDay()), searches);
}

export async function userDiscoveryUsage(userId: string) {
  const used = Number((await redis.get(key("quota", "user-discovery", userId, quotaDay()))) ?? 0);
  return { used, cap: env.DISCOVERY_SEARCHES_PER_USER_PER_DAY };
}
