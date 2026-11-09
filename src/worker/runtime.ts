import { DelayedError, UnrecoverableError, Worker, type Job } from "bullmq";
import { AppError } from "@/server/errors";
import { baseLogger, requestContext } from "@/server/logger";
import { bullConnection } from "@/server/redis";
import { BULL_PREFIX, CONCURRENCY, type JobPayloads, type QueueName } from "@/server/jobs";
import { YouTubeApiError } from "@/server/youtube";
import { nextResetAt } from "@/server/services/quota";
import { emitJobEvent, type JobControl } from "@/server/services/ingestion";
import { completeJob, ApprovalError } from "@/server/services/expansion";
import { PolicyBlockedError } from "@/server/youtube";

export type Processor<N extends QueueName> = (job: Job<JobPayloads[N]>, ctl: JobControl) => Promise<unknown>;

const RETRY_BACKOFF_MAX_MS = 10 * 60_000;

function proposalOf(job: Job): string | undefined {
  return (job.data as { auth?: { proposalId?: string } })?.auth?.proposalId;
}

function usage(result: unknown): { units?: number; searches?: number } {
  const r = result as { units?: number; searches?: number } | null;
  return { units: typeof r?.units === "number" ? r.units : 0, searches: typeof r?.searches === "number" ? r.searches : 0 };
}

function requestedBy(job: Job): string | undefined {
  const d = job.data as { requestedBy?: string };
  return d?.requestedBy;
}

/**
 * Wraps a processor with: request-ID propagation, progress events, and error policy —
 *  • QUOTA_EXHAUSTED → delay the job until the Pacific-midnight reset (no attempt consumed)
 *  • retryable upstream (5xx/429/network) → rethrow (exponential backoff with jitter)
 *  • other 4xx / NOT_FOUND / VALIDATION → UnrecoverableError (no retry)
 */
export function createWorker<N extends QueueName>(name: N, processor: Processor<N>): Worker<JobPayloads[N]> {
  const worker = new Worker<JobPayloads[N]>(
    name,
    async (job, token) => {
      const reqId = (job.data as { requestId?: string })?.requestId ?? `job-${job.id}`;
      return requestContext.run({ requestId: reqId, userId: requestedBy(job) }, async () => {
        const log = baseLogger.child({ queue: name, jobId: job.id, requestId: reqId });
        const ctl: JobControl = {
          jobId: job.id!,
          progress: async (pct, step, extra) => {
            await job.updateProgress({ pct: Math.round(pct), step, ...extra });
            await emitJobEvent("job.progress", { jobId: job.id!, queue: name, pct: Math.round(pct), step, ...extra }, requestedBy(job));
          },
        };
        const t0 = performance.now();
        try {
          const result = await processor(job, ctl);
          log.info({ ms: Math.round(performance.now() - t0), proposalId: proposalOf(job) }, "job completed");
          const pid = proposalOf(job);
          if (pid) await completeJob(pid, job.id!, { ok: true, ...usage(result), result: summarize(result) });
          return result;
        } catch (err) {
          if (err instanceof AppError && err.code === "QUOTA_EXHAUSTED") {
            const details = err.details as { resetAt?: string } | undefined;
            const until = details?.resetAt ? Date.parse(details.resetAt) : nextResetAt().getTime();
            log.warn({ until: new Date(until).toISOString() }, "quota exhausted; delaying job until reset");
            await emitJobEvent("job.progress", { jobId: job.id!, queue: name, step: "waiting-for-quota", resumeAt: new Date(until).toISOString() }, requestedBy(job));
            await job.moveToDelayed(until + 5_000, token);
            throw new DelayedError();
          }
          if (err instanceof YouTubeApiError) {
            if (err.retryable) throw err;
            throw new UnrecoverableError(`YouTube ${err.status} ${err.reason}: ${err.message}`);
          }
          if (err instanceof ApprovalError || err instanceof PolicyBlockedError) {
            log.warn({ proposalId: proposalOf(job), err: err.message }, "job refused: not authorized");
            throw new UnrecoverableError(err.message);
          }
          if (err instanceof AppError && ["NOT_FOUND", "VALIDATION_ERROR", "FORBIDDEN", "CONFLICT"].includes(err.code)) {
            throw new UnrecoverableError(err.message);
          }
          throw err;
        }
      });
    },
    {
      connection: bullConnection(),
      prefix: BULL_PREFIX,
      concurrency: CONCURRENCY[name],
      settings: {
        backoffStrategy: (attemptsMade: number) => {
          const base = Math.min(RETRY_BACKOFF_MAX_MS, 2_000 * 2 ** (attemptsMade - 1));
          return Math.floor(base / 2 + Math.random() * (base / 2));
        },
      },
    },
  );

  worker.on("completed", (job, result) => {
    void emitJobEvent("job.completed", { jobId: job.id!, queue: name, result: summarize(result) }, requestedBy(job)).catch(() => undefined);
  });
  worker.on("failed", (job, err) => {
    if (!job) return;
    const final = err instanceof UnrecoverableError || err.name === "UnrecoverableError" || job.attemptsMade >= (job.opts.attempts ?? 1);
    baseLogger.error({ queue: name, jobId: job.id, attempts: job.attemptsMade, final, err: err.message }, "job failed");
    if (final) {
      void emitJobEvent("job.failed", { jobId: job.id!, queue: name, error: err.message }, requestedBy(job)).catch(() => undefined);
      const pid = proposalOf(job);
      if (pid) void completeJob(pid, job.id!, { ok: false, error: err.message.slice(0, 500) }).catch((e) => baseLogger.error({ e, pid }, "could not record job failure"));
    }
  });
  worker.on("error", (err) => baseLogger.error({ queue: name, err }, "worker error"));
  return worker;
}

function summarize(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const s = JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? Number(v) : v));
  return s.length > 4_000 ? { truncated: true } : JSON.parse(s);
}
