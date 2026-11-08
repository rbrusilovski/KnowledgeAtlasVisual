import { Redis, type RedisOptions } from "ioredis";
import { env } from "./env";

const globalForRedis = globalThis as unknown as { __atlasRedis?: Redis };

export function createRedis(opts: RedisOptions = {}): Redis {
  return new Redis(env.REDIS_URL, { lazyConnect: false, enableAutoPipelining: true, ...opts });
}

/** Shared command connection (cache, quota, rate limit, publish). */
export const redis: Redis = globalForRedis.__atlasRedis ?? createRedis({ maxRetriesPerRequest: 3 });
if (env.NODE_ENV !== "production") globalForRedis.__atlasRedis = redis;

/** BullMQ requires maxRetriesPerRequest: null on its connections. */
export function bullConnection(): Redis {
  return createRedis({ maxRetriesPerRequest: null, enableAutoPipelining: false });
}

export const key = (...parts: (string | number)[]) => [env.REDIS_PREFIX, ...parts].join(":");
