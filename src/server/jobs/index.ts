/**
 * Queue definitions shared by the web process (enqueue) and the worker (process).
 * Deterministic job IDs coalesce duplicate requests (spec §7.9). BullMQ forbids ':' in custom
 * IDs, so IDs use '-' (e.g. `ingest-UC…`).
 */
import { createHash } from "node:crypto";
import { Queue, QueueEvents, type JobsOptions } from "bullmq";
import { bullConnection, redis, key } from "@/server/redis";
import { env } from "@/server/env";
import { currentRequestId } from "@/server/logger";

export const QUEUES = {
  ingest: "ingest-channel",
  sync: "sync-channel",
  stats: "refresh-stats",
  transcript: "fetch-transcript",
  embed: "embed",
  topics: "extract-topics",
  classify: "classify-channel",
  graph: "graph-build",
  communities: "communities",
  ai: "ai-extract",
  compliance: "compliance",
  scheduler: "scheduler",
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export type Lane = "interactive" | "background";

export interface JobPayloads {
  "ingest-channel": { youtubeId: string; requestedBy?: string; full?: boolean; aliases?: string[]; lane: Lane; requestId?: string; discoveredWith?: string[] };
  "sync-channel": { channelId: string; lane?: Lane; requestedBy?: string; requestId?: string };
  "refresh-stats": { videoIds: string[] };
  "fetch-transcript": { videoId: string; provider: string };
  embed: { entity: "channel" | "video" | "topic" | "chunk" | "niche"; ids: string[] };
  "extract-topics": { videoIds: string[] };
  "classify-channel": { channelId: string };
  "graph-build": { dirtyNodeIds?: string[]; full?: boolean };
  communities: Record<string, never>;
  "ai-extract": { targetType: "video"; targetId: string; contentHash?: string; requestedBy?: string };
  compliance: Record<string, never>;
  scheduler: { task?: "sync" | "stats" };
}

export const CONCURRENCY: Record<QueueName, number> = {
  "ingest-channel": 3,
  "sync-channel": 5,
  "refresh-stats": 5,
  "fetch-transcript": 2,
  embed: 1,
  "extract-topics": 2,
  "classify-channel": 4,
  "graph-build": 1,
  communities: 1,
  "ai-extract": 2,
  compliance: 1,
  scheduler: 1,
};

export const BULL_PREFIX = `${env.REDIS_PREFIX}-bull`;

const DEFAULT_OPTS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 2_000, jitter: 0.5 },
  removeOnComplete: { age: 24 * 3600, count: 2_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

const g = globalThis as unknown as { __atlasQueues?: Map<string, Queue>; __atlasQueueEvents?: Map<string, QueueEvents> };
const queues = (g.__atlasQueues ??= new Map());
const events = (g.__atlasQueueEvents ??= new Map());

export function getQueue<N extends QueueName>(name: N): Queue<JobPayloads[N]> {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection: bullConnection(), prefix: BULL_PREFIX, defaultJobOptions: DEFAULT_OPTS });
    queues.set(name, q);
  }
  return q as Queue<JobPayloads[N]>;
}

export function getQueueEvents(name: QueueName): QueueEvents {
  let e = events.get(name);
  if (!e) {
    e = new QueueEvents(name, { connection: bullConnection(), prefix: BULL_PREFIX });
    events.set(name, e);
  }
  return e;
}

export const hashIds = (ids: string[]) => createHash("sha1").update([...ids].sort().join(",")).digest("hex").slice(0, 16);
const hourStamp = (d = new Date()) => d.toISOString().slice(0, 13).replace(/[-T]/g, "");

async function add<N extends QueueName>(name: N, data: JobPayloads[N], opts: JobsOptions = {}) {
  return getQueue(name).add(name as never, data as never, opts);
}

/** Enqueue helpers with deterministic IDs. */
export const enqueue = {
  ingest: (p: Omit<JobPayloads["ingest-channel"], "requestId">) =>
    add(
      QUEUES.ingest,
      { ...p, requestId: currentRequestId() },
      { jobId: `ingest-${p.youtubeId}${p.full ? "-full" : ""}`, priority: p.lane === "interactive" ? 1 : 10 },
    ),
  sync: (channelId: string, lane: Lane = "background", requestedBy?: string) =>
    add(
      QUEUES.sync,
      { channelId, lane, requestedBy, requestId: currentRequestId() },
      { jobId: `sync-${channelId}-${hourStamp()}${lane === "interactive" ? `-m${Date.now()}` : ""}`, priority: lane === "interactive" ? 1 : 10 },
    ),
  stats: (videoIds: string[]) => add(QUEUES.stats, { videoIds }, { jobId: `stats-${hashIds(videoIds)}-${hourStamp()}` }),
  transcript: (videoId: string, provider: string) => add(QUEUES.transcript, { videoId, provider }, { jobId: `tx-${videoId}` }),
  embed: (entity: JobPayloads["embed"]["entity"], ids: string[]) =>
    ids.length ? add(QUEUES.embed, { entity, ids }, { jobId: `embed-${entity}-${hashIds(ids)}` }) : null,
  topics: (videoIds: string[]) => (videoIds.length ? add(QUEUES.topics, { videoIds }, { jobId: `topics-${hashIds(videoIds)}` }) : null),
  classify: (channelId: string) => add(QUEUES.classify, { channelId }, { jobId: `cls-${channelId}-${Date.now()}`, deduplication: { id: `cls-${channelId}`, ttl: 5_000 } }),
  /** Debounced: dirty node IDs accumulate in a Redis set; one build drains them. */
  graph: async (dirtyNodeIds: string[]) => {
    if (dirtyNodeIds.length) await redis.sadd(key("graph", "dirty"), ...dirtyNodeIds);
    return add(QUEUES.graph, {}, { delay: 1_500, deduplication: { id: "graph-build", ttl: 1_500, extend: true, replace: true, keepLastIfActive: true } });
  },
  graphFull: () => add(QUEUES.graph, { full: true }, { jobId: `graph-full-${Date.now()}` }),
  communities: () => add(QUEUES.communities, {}, { delay: 10_000, deduplication: { id: "communities", ttl: 10_000, extend: true, replace: true, keepLastIfActive: true } }),
  ai: (p: JobPayloads["ai-extract"]) => add(QUEUES.ai, p, { jobId: `ai-${p.targetType}-${p.targetId}-${p.contentHash ?? "x"}` }),
};

/** Look up a job by ID across queues (job IDs are prefixed by kind). */
export async function findJob(jobId: string) {
  for (const name of Object.values(QUEUES)) {
    const job = await getQueue(name).getJob(jobId);
    if (job) return { queue: name, job };
  }
  return null;
}

export async function queueCounts() {
  const out: Record<string, Record<string, number>> = {};
  for (const name of Object.values(QUEUES)) {
    out[name] = await getQueue(name).getJobCounts("waiting", "active", "delayed", "failed", "completed", "prioritized");
  }
  return out;
}

export async function closeQueues() {
  await Promise.all([...queues.values()].map((q) => q.close()));
  await Promise.all([...events.values()].map((e) => e.close()));
  queues.clear();
  events.clear();
}
