import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Worker } from "bullmq";
import { db } from "@/server/db";
import { getQueue, QUEUES, enqueue } from "@/server/jobs";
import * as ingestion from "@/server/services/ingestion";
import { markExhausted } from "@/server/services/quota";
import { runCompliance } from "@/server/services/compliance";
import { resetFixtureStore } from "@/server/youtube/fixture";
import { startWorkers } from "@/worker/processors";
import { resetDb, flushRedis, drain, teardown, noopCtl, setServed, FIXTURE_CHANNEL } from "./helpers";

let workers: Worker[] = [];

beforeAll(async () => {
  workers = startWorkers();
  setServed(workers);
});
afterAll(async () => {
  delete process.env.FIXTURE_NOW;
  await teardown(workers);
});
beforeEach(async () => {
  delete process.env.FIXTURE_NOW;
  await drain().catch(() => undefined);
  await resetDb();
  await flushRedis();
});

describe("ingestion pipeline (fixture mode)", () => {
  it("ingests a fixture channel end-to-end without search calls", async () => {
    const r = await ingestion.ingestChannel({ youtubeId: FIXTURE_CHANNEL, lane: "interactive" }, noopCtl);
    expect(r.status).toBe("completed");
    expect(r.videos.created).toBeGreaterThan(10);
    const ch = await db.channel.findUniqueOrThrow({ where: { youtubeId: FIXTURE_CHANNEL } });
    expect(ch.uploadsPlaylistId).toBe(`UU${FIXTURE_CHANNEL.slice(2)}`);
    expect(await db.video.count({ where: { channelId: ch.id } })).toBe(r.videos.created);
    const run = await db.ingestionRun.findFirstOrThrow({ where: { targetId: FIXTURE_CHANNEL, kind: "ingest" } });
    expect(run.status).toBe("completed");
    expect(run.searchCalls).toBe(0);
    expect(run.unitsUsed).toBeGreaterThanOrEqual(3);
    await drain();
    expect(await db.transcript.count()).toBeGreaterThan(0);
    expect(await db.channelAlias.count({ where: { channelId: ch.id } })).toBeGreaterThanOrEqual(2);
  });

  it("re-ingest is idempotent (zero video changes)", async () => {
    await ingestion.ingestChannel({ youtubeId: FIXTURE_CHANNEL, lane: "interactive" }, noopCtl);
    await drain();
    const before = await db.video.findMany({ select: { id: true, updatedAt: true }, orderBy: { id: "asc" } });
    const chunksBefore = await db.transcriptChunk.count();
    const again = await ingestion.ingestChannel({ youtubeId: FIXTURE_CHANNEL, lane: "interactive" }, noopCtl);
    expect(again.videos).toMatchObject({ created: 0, updated: 0 });
    expect(again.videos.skipped).toBe(before.length);
    await drain();
    const after = await db.video.findMany({ select: { id: true, updatedAt: true }, orderBy: { id: "asc" } });
    expect(after).toEqual(before);
    expect(await db.transcriptChunk.count()).toBe(chunksBefore);
  });

  it("incremental sync stops at the first known video", async () => {
    // Pretend it's 60 days ago: newer uploads are not yet "published".
    process.env.FIXTURE_NOW = new Date(Date.now() - 60 * 86_400_000).toISOString();
    await ingestion.ingestChannel({ youtubeId: FIXTURE_CHANNEL, lane: "interactive" }, noopCtl);
    const ch = await db.channel.findUniqueOrThrow({ where: { youtubeId: FIXTURE_CHANNEL } });
    const initial = await db.video.count({ where: { channelId: ch.id } });
    delete process.env.FIXTURE_NOW;
    const s = await ingestion.syncChannel(ch.id, "background", noopCtl);
    expect(s.newVideos).toBeGreaterThan(0);
    expect(s.pages).toBe(1);
    expect(await db.video.count({ where: { channelId: ch.id } })).toBe(initial + s.newVideos);
    // A second sync finds nothing and costs ≤ 3 units (channels.list + 1 playlist page; no videos.list).
    const s2 = await ingestion.syncChannel(ch.id, "background", noopCtl);
    expect(s2).toMatchObject({ newVideos: 0, pages: 1 });
    expect(s2.units).toBeLessThanOrEqual(3);
  });

  it("quota exhaustion delays background jobs until reset", async () => {
    await ingestion.ingestChannel({ youtubeId: FIXTURE_CHANNEL, lane: "interactive" }, noopCtl);
    await drain();
    const ch = await db.channel.findUniqueOrThrow({ where: { youtubeId: FIXTURE_CHANNEL } });
    await markExhausted("general");
    const job = await enqueue.sync(ch.id, "background");
    const deadline = Date.now() + 15_000;
    let state = await job.getState();
    while (state !== "delayed" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      state = await job.getState();
    }
    expect(state).toBe("delayed");
    const fresh = await getQueue(QUEUES.sync).getJob(job.id!);
    expect(fresh!.attemptsMade).toBeLessThanOrEqual(1);
    expect(fresh!.delay + fresh!.timestamp).toBeGreaterThan(Date.now() + 60_000);
    await fresh!.remove();
  });

  it("assigns sync tiers (HOT when in a collection)", async () => {
    await ingestion.ingestChannel({ youtubeId: FIXTURE_CHANNEL, lane: "interactive" }, noopCtl);
    const ch = await db.channel.findUniqueOrThrow({ where: { youtubeId: FIXTURE_CHANNEL } });
    expect(await ingestion.computeTier(ch.id)).toBe("WARM");
    const user = await db.user.create({ data: { id: "u-tier", name: "T", email: "t@x.test" } });
    const ws = await db.workspace.create({ data: { ownerId: user.id, name: "w", collections: { create: { name: "c" } } }, include: { collections: true } });
    await db.collectionItem.create({ data: { collectionId: ws.collections[0]!.id, nodeId: `channel:${FIXTURE_CHANNEL}` } });
    expect(await ingestion.computeTier(ch.id)).toBe("HOT");
  });

  it("compliance refreshes stale records and deletes ones the API no longer returns", async () => {
    await ingestion.ingestChannel({ youtubeId: FIXTURE_CHANNEL, lane: "interactive" }, noopCtl);
    await drain();
    const old = new Date(Date.now() - 40 * 86_400_000);
    const [gone, ...rest] = await db.video.findMany({ orderBy: { publishedAt: "desc" }, take: 6, select: { id: true, youtubeId: true } });
    await db.channel.updateMany({ data: { lastRefreshedAt: old } });
    await db.video.updateMany({ where: { id: { in: [gone!.id, ...rest.map((r) => r.id)] } }, data: { lastRefreshedAt: old } });
    process.env.FIXTURE_REMOVED = gone!.youtubeId;
    resetFixtureStore();
    try {
      const report = await runCompliance();
      expect(report.channels.refreshed).toBe(1);
      expect(report.videos.refreshed).toBe(rest.length);
      expect(report.videos.deleted).toBe(1);
      expect(await db.video.findUnique({ where: { id: gone!.id } })).toBeNull();
      const stale = await db.video.count({ where: { lastRefreshedAt: { lt: new Date(Date.now() - 27 * 86_400_000) } } });
      expect(stale).toBe(0);
    } finally {
      delete process.env.FIXTURE_REMOVED;
      resetFixtureStore();
    }
  });
});
