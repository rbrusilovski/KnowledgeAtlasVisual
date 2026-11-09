import type { Worker } from "bullmq";
import { QUEUES, enqueue } from "@/server/jobs";
import * as ingestion from "@/server/services/ingestion";
import * as transcripts from "@/server/services/transcripts";
import { runCompliance } from "@/server/services/compliance";
import { embedEntities, warmup } from "@/server/services/embeddings";
import { extractTopics, applyAiTopics } from "@/server/services/topics";
import { classifyChannel } from "@/server/services/classification";
import { aiEnabled, extractVideo } from "@/server/services/ai";
import { buildFromDirtySet, buildDirty, rebuildAll, computeCommunities, pruneTombstones } from "@/server/services/graph";
import { createWorker } from "./runtime";

/** Each queue → processor. Kept thin: all logic lives in services. */
export function startWorkers(): Worker[] {
  warmup();
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
    createWorker(QUEUES.embed, (job) => embedEntities(job.data.entity, job.data.ids)),
    createWorker(QUEUES.topics, async (job) => {
      const r = await extractTopics(job.data.videoIds);
      return r;
    }),
    createWorker(QUEUES.classify, (job) => classifyChannel(job.data.channelId)),
    createWorker(QUEUES.graph, async (job) => {
      const stats = job.data.full ? await rebuildAll() : job.data.dirtyNodeIds?.length ? await buildDirty(job.data.dirtyNodeIds) : await buildFromDirtySet();
      // Communities after significant change (debounced job).
      if (stats && (stats.edgesChanged + stats.edgesRemoved > 0 || stats.nodesRemoved > 0)) await enqueue.communities();
      return stats ?? { idle: true };
    }),
    createWorker(QUEUES.communities, async () => {
      await pruneTombstones();
      return computeCommunities();
    }),
    createWorker(QUEUES.ai, async (job) => {
      if (!aiEnabled()) return { skipped: "ai disabled" };
      const r = await extractVideo(job.data.targetId);
      await applyAiTopics(job.data.targetId, r.output.topics);
      return { cached: r.cached, topics: r.output.topics.length };
    }),
  ];
}

export { enqueue };
