/**
 * YouTube API Developer Policies: stored API data must be refreshed or deleted within 30 days.
 * Daily job: anything with lastRefreshedAt older than 27 days is refreshed (batched, 1 unit per 50 IDs)
 * or — if the background budget can't cover it — deleted. Records the API no longer returns are deleted.
 */
import { db } from "@/server/db";
import { log } from "@/server/logger";
import { enqueue } from "@/server/jobs";
import { youtube, withYouTubeContext } from "@/server/youtube";
import * as quota from "@/server/services/quota";

export const STALE_AFTER_DAYS = 27;

export interface ComplianceReport {
  channels: { refreshed: number; deleted: number; deletedNoBudget: number };
  videos: { refreshed: number; deleted: number; deletedNoBudget: number };
  units: number;
}

export async function runCompliance(now = new Date()): Promise<ComplianceReport> {
  const cutoff = new Date(now.getTime() - STALE_AFTER_DAYS * 86_400_000);
  const report: ComplianceReport = {
    channels: { refreshed: 0, deleted: 0, deletedNoBudget: 0 },
    videos: { refreshed: 0, deleted: 0, deletedNoBudget: 0 },
    units: 0,
  };
  const dirty = new Set<string>();

  await withYouTubeContext({ lane: "background", noCache: true, onCost: (_m, _b, u) => (report.units += u) }, async () => {
    // Channels
    const staleChannels = await db.channel.findMany({
      where: { OR: [{ lastRefreshedAt: null }, { lastRefreshedAt: { lt: cutoff } }] },
      select: { id: true, youtubeId: true },
    });
    for (let i = 0; i < staleChannels.length; i += 50) {
      const batch = staleChannels.slice(i, i + 50);
      if (!(await quota.canSpend("general", 1, "background"))) {
        await deleteChannels(batch.map((c) => c.id));
        batch.forEach((c) => dirty.add(`channel:${c.youtubeId}`));
        report.channels.deletedNoBudget += batch.length;
        continue;
      }
      const fresh = await youtube.getChannels({ ids: batch.map((c) => c.youtubeId) });
      const returned = new Map(fresh.map((c) => [c.id, c]));
      const gone = batch.filter((c) => !returned.has(c.youtubeId));
      for (const c of batch) {
        const yt = returned.get(c.youtubeId);
        if (!yt) continue;
        await db.channel.update({
          where: { id: c.id },
          data: {
            title: yt.snippet?.title,
            description: yt.snippet?.description ?? "",
            subscriberCount: yt.statistics?.hiddenSubscriberCount ? null : (yt.statistics?.subscriberCount ?? null),
            viewCount: yt.statistics?.viewCount ?? null,
            videoCount: yt.statistics?.videoCount !== undefined ? Number(yt.statistics.videoCount) : null,
            etag: yt.etag ?? null,
            lastRefreshedAt: now,
            lastStatsAt: now,
            isAvailable: true,
          },
        });
        report.channels.refreshed++;
      }
      if (gone.length) {
        await deleteChannels(gone.map((c) => c.id));
        gone.forEach((c) => dirty.add(`channel:${c.youtubeId}`));
        report.channels.deleted += gone.length;
      }
    }

    // Videos
    const staleVideos = await db.video.findMany({
      where: { OR: [{ lastRefreshedAt: null }, { lastRefreshedAt: { lt: cutoff } }] },
      select: { id: true, youtubeId: true },
      take: 50_000,
    });
    for (let i = 0; i < staleVideos.length; i += 50) {
      const batch = staleVideos.slice(i, i + 50);
      if (!(await quota.canSpend("general", 1, "background"))) {
        await db.video.deleteMany({ where: { id: { in: batch.map((v) => v.id) } } });
        batch.forEach((v) => dirty.add(`video:${v.youtubeId}`));
        report.videos.deletedNoBudget += batch.length;
        continue;
      }
      const fresh = await youtube.getVideos(batch.map((v) => v.youtubeId));
      const returned = new Map(fresh.map((v) => [v.id, v]));
      for (const v of batch) {
        const yt = returned.get(v.youtubeId);
        if (!yt) continue;
        await db.video.update({
          where: { id: v.id },
          data: {
            title: yt.snippet?.title,
            description: yt.snippet?.description ?? "",
            tags: yt.snippet?.tags ?? [],
            viewCount: yt.statistics?.viewCount ?? null,
            likeCount: yt.statistics?.likeCount ?? null,
            commentCount: yt.statistics?.commentCount ?? null,
            etag: yt.etag ?? null,
            lastRefreshedAt: now,
            lastStatsAt: now,
            isAvailable: true,
          },
        });
        report.videos.refreshed++;
      }
      const gone = batch.filter((v) => !returned.has(v.youtubeId));
      if (gone.length) {
        await db.video.deleteMany({ where: { id: { in: gone.map((v) => v.id) } } });
        gone.forEach((v) => dirty.add(`video:${v.youtubeId}`));
        report.videos.deleted += gone.length;
      }
    }
  });

  if (dirty.size) await enqueue.graph([...dirty]);
  log().info(report, "compliance run finished");
  return report;
}

async function deleteChannels(ids: string[]) {
  if (!ids.length) return;
  // Videos, transcripts, chunks, topics links, niche links and aliases cascade.
  await db.channel.deleteMany({ where: { id: { in: ids } } });
}
