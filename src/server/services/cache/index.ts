import { createHash } from "node:crypto";
import { redis, key } from "@/server/redis";
import { log } from "@/server/logger";

interface Entry<T> {
  v: T;
  /** Fresh-until (epoch ms). */
  f: number;
}

export function hashParams(params: unknown): string {
  return createHash("sha1").update(stableStringify(params)).digest("hex").slice(0, 20);
}

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

const revive = (_k: string, v: unknown) => (v && typeof v === "object" && "__big" in v ? BigInt((v as { __big: string }).__big) : v);
const replace = (_k: string, v: unknown) => (typeof v === "bigint" ? { __big: v.toString() } : v);

export interface CacheOptions {
  ttlSec: number;
  /** Serve stale for this long after expiry while refreshing in the background. */
  swrSec?: number;
}

/**
 * Read-through cache with optional stale-while-revalidate. Keys are namespaced: `cache:<ns>:<hash>`.
 * Values may contain BigInt.
 */
export async function cached<T>(ns: string, params: unknown, opts: CacheOptions, fn: () => Promise<T>): Promise<T> {
  const k = key("cache", ns, hashParams(params));
  const raw = await redis.get(k).catch(() => null);
  const now = Date.now();
  if (raw) {
    const entry = JSON.parse(raw, revive) as Entry<T>;
    if (entry.f > now) return entry.v;
    if (opts.swrSec) {
      void refresh(k, opts, fn);
      return entry.v;
    }
  }
  return store(k, opts, await fn());
}

async function store<T>(k: string, opts: CacheOptions, v: T): Promise<T> {
  const entry: Entry<T> = { v, f: Date.now() + opts.ttlSec * 1000 };
  await redis.set(k, JSON.stringify(entry, replace), "EX", opts.ttlSec + (opts.swrSec ?? 0)).catch(() => undefined);
  return v;
}

async function refresh<T>(k: string, opts: CacheOptions, fn: () => Promise<T>) {
  const lock = `${k}:lock`;
  const got = await redis.set(lock, "1", "EX", 30, "NX").catch(() => null);
  if (!got) return;
  try {
    await store(k, opts, await fn());
  } catch (err) {
    log().warn({ err, k }, "swr refresh failed");
  } finally {
    await redis.del(lock).catch(() => undefined);
  }
}

export async function invalidate(ns: string, params?: unknown) {
  if (params !== undefined) {
    await redis.del(key("cache", ns, hashParams(params)));
    return;
  }
  const stream = redis.scanStream({ match: key("cache", ns, "*"), count: 200 });
  for await (const keys of stream as AsyncIterable<string[]>) if (keys.length) await redis.del(...keys);
}

/** Simple JSON get/set for non-read-through uses. */
export async function getJson<T>(k: string): Promise<T | null> {
  const raw = await redis.get(key("kv", k));
  return raw ? (JSON.parse(raw, revive) as T) : null;
}
export async function setJson(k: string, v: unknown, ttlSec: number) {
  await redis.set(key("kv", k), JSON.stringify(v, replace), "EX", ttlSec);
}

/** Short mutual-exclusion lock (dedup around ingestion of the same channel). */
export async function withLock<T>(name: string, ttlSec: number, fn: () => Promise<T>): Promise<T | null> {
  const k = key("lock", name);
  const token = Math.random().toString(36).slice(2);
  const ok = await redis.set(k, token, "EX", ttlSec, "NX");
  if (!ok) return null;
  try {
    return await fn();
  } finally {
    await redis.eval(`if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`, 1, k, token);
  }
}
