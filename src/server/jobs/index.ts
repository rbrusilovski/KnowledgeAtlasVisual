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
import { db } from "@/server/db";
import { AppError } from "@/server/errors";

export const QUEUES = {
  ingest: "ingest-channel",
  sync: "sync-channel",
  backfill: "backfill-history",
  discover: "discover-channels",
  refresh: "refresh-metadata",
  transcript: "fetch-transcript",
  embed: "embed",
  topics: "extract-topics",
  classify: "classify-channel",
  taxonomy: "taxonomy-classify",
  graph: "graph-build",
  communities: "communities",
  ai: "ai-extract",
  compliance: "compliance",
  scheduler: "scheduler",
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export type Lane = "interactive" | "background";

/**
 * Every job that adds to or refreshes the corpus carries the approved proposal it executes under. The worker/service
 * re-validates it (status, scope hash, job registration, target ∈ scope) before persisting anything.
 */
export interface ExpansionAuth {
  proposalId: string;
  scopeHash: string;
}

interface Authorized {
  auth: ExpansionAuth;
  lane: Lane;
  requestedBy?: string;
  requestId?: string;
}

export interface JobPayloads {
  "ingest-channel": Authorized & { youtubeId: string; aliases?: string[] };
  "sync-channel": Authorized & { youtubeId: string };
  "backfill-history": Authorized & { youtubeId: string; slice: number };
  "discover-channels": Authorized;
  "refresh-metadata": Authorized & { channelYoutubeIds: string[]; videoYoutubeIds: string[] };
  "fetch-transcript": { videoId: string; provider: string; connectionId?: string; auth: ExpansionAuth };
  embed: { entity: "channel" | "video" | "topic" | "chunk" | "niche"; ids: string[] };
  "extract-topics": { videoIds: string[] };
  "classify-channel": { channelId: string };
  "taxonomy-classify": { videoIds: string[] };
  "graph-build": { dirtyNodeIds?: string[]; full?: boolean };
  communities: Record<string, never>;
  "ai-extract": { targetType: "video"; targetId: string; contentHash?: string; requestedBy?: string };
  compliance: Record<string, never>;
  scheduler: { task?: "sync" | "stats" | "proposals" };
}

/** Queues whose jobs expand or refresh the corpus — only enqueueable under an approved, running proposal. */
export const EXPANSION_QUEUES = ["ingest-channel", "sync-channel", "backfill-history", "discover-channels", "refresh-metadata"] as const;
export type ExpansionQueue = (typeof EXPANSION_QUEUES)[number];

export const CONCURRENCY: Record<QueueName, number> = {
  "ingest-channel": 3,
  "sync-channel": 5,
  // Backfills run in bounded slices that re-enqueue themselves at low priority, so they never starve other work.
  "backfill-history": 2,
  "discover-channels": 1,
  "refresh-metadata": 3,
  "fetch-transcript": 2,
  embed: 1,
  "extract-topics": 2,
  "classify-channel": 4,
  // Single consumer: category creation is also serialized by a Postgres advisory lock.
  "taxonomy-classify": 1,
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

async function add<N extends QueueName>(name: N, data: JobPayloads[N], opts: JobsOptions = {}) {
  return getQueue(name).add(name as never, data as never, opts);
}

/** Deterministic job IDs for proposal work: retries of the same job coalesce; a new proposal never reuses an old ID. */
export const expansionJobId = (proposalId: string, part: string) => `x-${proposalId}-${part}`.replace(/:/g, "-");

/**
 * Producer-side approval check: the proposal must be RUNNING, the job ID registered on it, and the scope hash must
 * match. (The executing service checks again — this is defence in depth, not the only gate.)
 */
async function assertDispatchable(auth: ExpansionAuth, jobId: string) {
  const p = await db.expansionProposal.findUnique({ where: { id: auth.proposalId }, select: { status: true, scopeHash: true, jobIds: true } });
  if (!p || p.status !== "RUNNING" || p.scopeHash !== auth.scopeHash || !p.jobIds.includes(jobId)) {
    throw new AppError("FORBIDDEN", `Job ${jobId} is not authorized by an approved, running proposal`);
  }
}

/** The only way to enqueue corpus-expanding work. */
export async function enqueueExpansion<N extends ExpansionQueue>(name: N, data: Omit<JobPayloads[N], "requestId">, jobId: string) {
  await assertDispatchable((data as Authorized).auth, jobId);
  const lane = (data as Authorized).lane;
  return add(name, { ...data, requestId: currentRequestId() } as JobPayloads[N], { jobId, priority: name === "backfill-history" ? 20 : lane === "interactive" ? 1 : 10 });
}

/** Enqueue helpers for local processing (no YouTube collection) — deterministic IDs coalesce duplicates. */
export const enqueue = {
  /** Transcript fetches run under the approval of the collection that found the video (registered as a child job). */
  transcript: (videoId: string, provider: string, connectionId: string | undefined, auth: ExpansionAuth, jobId: string) =>
    add(QUEUES.transcript, { videoId, provider, connectionId, auth }, { jobId }),
  embed: (entity: JobPayloads["embed"]["entity"], ids: string[]) =>
    ids.length ? add(QUEUES.embed, { entity, ids }, { jobId: `embed-${entity}-${hashIds(ids)}` }) : null,
  topics: (videoIds: string[]) => (videoIds.length ? add(QUEUES.topics, { videoIds }, { jobId: `topics-${hashIds(videoIds)}` }) : null),
  classify: (channelId: string) => add(QUEUES.classify, { channelId }, { jobId: `cls-${channelId}-${Date.now()}`, deduplication: { id: `cls-${channelId}`, ttl: 5_000 } }),
  /** Classify already-collected videos into the dynamic taxonomy (internal derived data; collects nothing). */
  taxonomy: (videoIds: string[]) => (videoIds.length ? add(QUEUES.taxonomy, { videoIds }, { jobId: `tax-${hashIds(videoIds)}` }) : null),
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
