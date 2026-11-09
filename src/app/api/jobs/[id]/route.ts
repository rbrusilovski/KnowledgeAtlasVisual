import { withRoute } from "@/server/http/withRoute";
import { findJob } from "@/server/jobs";
import { notFound } from "@/server/errors";
import { IdParam } from "@/shared/contracts/common";
import type { JobStatus } from "@/shared/contracts/jobs";

/** Job status for the user who requested it (admins: any). Previously unauthenticated. */
export const GET = withRoute({ auth: "required", params: IdParam }, async ({ params, user }): Promise<JobStatus> => {
  const found = await findJob(params.id);
  const owner = (found?.job.data as { requestedBy?: string } | undefined)?.requestedBy;
  if (!found || (user.role !== "ADMIN" && owner !== user.id)) throw notFound("Job");
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
