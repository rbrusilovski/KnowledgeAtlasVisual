import type { Worker } from "bullmq";
import { QUEUES, enqueue } from "@/server/jobs";
import * as ingestion from "@/server/services/ingestion";
import * as transcripts from "@/server/services/transcripts";
import { runCompliance } from "@/server/services/compliance";
import { authorizeJob, expireProposals } from "@/server/services/expansion";
import { embedEntities, warmup } from "@/server/services/embeddings";
import { extractTopics, applyAiTopics } from "@/server/services/topics";
import { classifyChannel } from "@/server/services/classification";
import { classifyVideos } from "@/server/services/taxonomy";
import { aiEnabled, extractVideo } from "@/server/services/ai";
import { buildFromDirtySet, buildDirty, rebuildAll, computeCommunities, pruneTombstones } from "@/server/services/graph";
import { db } from "@/server/db";
import { createWorker } from "./runtime";

/**
 * Each queue → processor. Kept thin: all logic (including approval checks) lives in services. Collection queues
 * pass the job's approval envelope through; the services reject anything the proposal does not authorize.
 */
export function startWorkers(): Worker[] {
  warmup();
  return [
    createWorker(QUEUES.ingest, (job, ctl) => ingestion.ingestChannel({ auth: job.data.auth, lane: job.data.lane, requestedBy: job.data.requestedBy, youtubeId: job.data.youtubeId, aliases: job.data.aliases }, ctl)),
    createWorker(QUEUES.sync, (job, ctl) => ingestion.syncChannel({ auth: job.data.auth, lane: job.data.lane, requestedBy: job.data.requestedBy, youtubeId: job.data.youtubeId }, ctl)),
    createWorker(QUEUES.backfill, (job, ctl) => ingestion.backfillHistory({ auth: job.data.auth, lane: job.data.lane, requestedBy: job.data.requestedBy, youtubeId: job.data.youtubeId, slice: job.data.slice }, ctl)),
    createWorker(QUEUES.discover, (job, ctl) => ingestion.discoverChannelsApproved({ auth: job.data.auth, lane: job.data.lane, requestedBy: job.data.requestedBy }, ctl)),
    createWorker(QUEUES.refresh, (job, ctl) =>
      ingestion.refreshMetadata({ auth: job.data.auth, lane: job.data.lane, requestedBy: job.data.requestedBy, channelYoutubeIds: job.data.channelYoutubeIds, videoYoutubeIds: job.data.videoYoutubeIds }, ctl),
    ),
    createWorker(QUEUES.transcript, async (job) => {
      const v = await db.video.findUnique({ where: { id: job.data.videoId }, select: { channel: { select: { youtubeId: true } } } });
      if (!v) return { skipped: "video deleted" };
      await authorizeJob(job.data.auth, job.id, ["ADD_CHANNELS", "DISCOVER_CHANNELS", "BACKFILL_HISTORY", "SYNC_UPLOADS"], { channelYoutubeId: v.channel.youtubeId });
      return transcripts.fetchAndStore(job.data.videoId, job.data.provider, job.data.connectionId);
    }),
    createWorker(QUEUES.scheduler, async (job) => {
      if (job.data.task === "stats") return ingestion.scheduleStatsRefresh();
      if (job.data.task === "proposals") return expireProposals();
      return ingestion.scheduleDueSyncs();
    }),
    createWorker(QUEUES.compliance, () => runCompliance()),
    createWorker(QUEUES.embed, (job) => embedEntities(job.data.entity, job.data.ids)),
    createWorker(QUEUES.topics, (job) => extractTopics(job.data.videoIds)),
    createWorker(QUEUES.classify, (job) => classifyChannel(job.data.channelId)),
    // Internal classification of already-collected videos: no YouTube calls, no approval needed.
    createWorker(QUEUES.taxonomy, (job) => classifyVideos(job.data.videoIds)),
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
