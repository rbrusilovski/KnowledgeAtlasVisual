import { redis, key } from "../redis";
import { AppError } from "../errors";

export interface RateLimitSpec {
  /** Bucket name, e.g. "api", "discovery", "channel-add". */
  name: string;
  limit: number;
  windowSec: number;
}

/**
 * Sliding-window log in a sorted set (atomic Lua). Returns remaining + retryAfter.
 * Precise for the window sizes we use (≤ 1 day) and bounded by `limit` entries per key.
 */
const SCRIPT = `
local k = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', k, 0, now - window)
local count = redis.call('ZCARD', k)
if count >= limit then
  local oldest = redis.call('ZRANGE', k, 0, 0, 'WITHSCORES')
  local retry = window
  if oldest[2] then retry = (tonumber(oldest[2]) + window) - now end
  return {0, count, retry}
end
redis.call('ZADD', k, now, member)
redis.call('PEXPIRE', k, window)
return {1, count + 1, 0}
`;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

export async function checkRateLimit(spec: RateLimitSpec, subject: string): Promise<RateLimitResult> {
  const now = Date.now();
  const windowMs = spec.windowSec * 1000;
  const member = `${now}-${Math.random().toString(36).slice(2, 8)}`;
  const [ok, count, retry] = (await redis.eval(
    SCRIPT,
    1,
    key("rl", spec.name, subject),
    now,
    windowMs,
    spec.limit,
    member,
  )) as [number, number, number];
  return {
    allowed: ok === 1,
    remaining: Math.max(0, spec.limit - count),
    retryAfterSec: Math.max(1, Math.ceil(retry / 1000)),
  };
}

export async function enforceRateLimit(spec: RateLimitSpec, subject: string): Promise<void> {
  const r = await checkRateLimit(spec, subject);
  if (!r.allowed) {
    throw new AppError(
      "RATE_LIMITED",
      `Rate limit exceeded for ${spec.name}. Try again in ${r.retryAfterSec}s.`,
      { bucket: spec.name, retryAfterSec: r.retryAfterSec },
      { "Retry-After": String(r.retryAfterSec) },
    );
  }
}
