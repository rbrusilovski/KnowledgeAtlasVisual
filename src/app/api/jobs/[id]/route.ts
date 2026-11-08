import { withRoute } from "@/server/http/withRoute";
import { findJob } from "@/server/jobs";
import { notFound } from "@/server/errors";
import { IdParam } from "@/shared/contracts/common";
import type { JobStatus } from "@/shared/contracts/jobs";

export const GET = withRoute({ auth: "none", params: IdParam }, async ({ params }): Promise<JobStatus> => {
  const found = await findJob(params.id);
  if (!found) throw notFound("Job");
  const { job, queue } = found;
  const state = (await job.getState()) as JobStatus["state"];
  return {
    id: job.id!,
    queue,
    state,
    progress: (job.progress as JobStatus["progress"]) ?? null,
    attemptsMade: job.attemptsMade,
    failedReason: job.failedReason || undefined,
    result: state === "completed" ? job.returnvalue : undefined,
    createdAt: new Date(job.timestamp).toISOString(),
    finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : undefined,
  };
});
