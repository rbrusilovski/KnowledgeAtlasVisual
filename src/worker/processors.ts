import type { Worker } from "bullmq";
import { QUEUES, enqueue } from "@/server/jobs";
import * as ingestion from "@/server/services/ingestion";
import * as transcripts from "@/server/services/transcripts";
import { runCompliance } from "@/server/services/compliance";
import { createWorker } from "./runtime";

/** Each queue → processor. Kept thin: all logic lives in services. */
export function startWorkers(): Worker[] {
  return [
    createWorker(QUEUES.ingest, (job, ctl) =>
      ingestion.ingestChannel(
        { youtubeId: job.data.youtubeId, requestedBy: job.data.requestedBy, full: job.data.full, aliases: job.data.aliases, lane: job.data.lane },
        ctl,
      ),
    ),
    createWorker(QUEUES.sync, (job, ctl) => ingestion.syncChannel(job.data.channelId, job.data.lane ?? "background", ctl, job.data.requestedBy)),
    createWorker(QUEUES.stats, async (job) => {
      const r = await ingestion.refreshStats(job.data.videoIds, "background");
      return r;
    }),
    createWorker(QUEUES.transcript, (job) => transcripts.fetchAndStore(job.data.videoId, job.data.provider)),
    createWorker(QUEUES.scheduler, async (job) => {
      if (job.data.task === "stats") return ingestion.scheduleStatsRefresh();
      return ingestion.scheduleDueSyncs();
    }),
    createWorker(QUEUES.compliance, () => runCompliance()),
  ];
}

export { enqueue };
