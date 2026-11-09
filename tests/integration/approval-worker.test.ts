/** Approval → BullMQ workers → proposal bookkeeping, with the real processors. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Worker } from "bullmq";
import { db } from "@/server/db";
import { getQueue, QUEUES } from "@/server/jobs";
import * as ingestion from "@/server/services/ingestion";
import { markExhausted } from "@/server/services/quota";
import { search } from "@/server/services/search";
import { seedTaxonomy } from "@/server/services/classification";
import { embedEntities } from "@/server/services/embeddings";
import { startWorkers } from "@/worker/processors";
import { approved, authOf, ctlFor, drain, flushRedis, makeUser, resetDb, setServed, teardown, FIXTURE_CHANNEL } from "./helpers";

let workers: Worker[] = [];
let owner: Awaited<ReturnType<typeof makeUser>>;

beforeAll(async () => {
  workers = startWorkers();
  setServed(workers);
});
afterAll(async () => teardown(workers));
beforeEach(async () => {
  await drain().catch(() => undefined);
  await resetDb();
  await flushRedis();
  owner = await makeUser("owner@atlas.test");
  await embedEntities("niche", await seedTaxonomy());
});

async function waitFor(id: string, statuses: string[], ms = 120_000) {
  const t0 = Date.now();
  for (;;) {
    const p = await db.expansionProposal.findUniqueOrThrow({ where: { id } });
    if (statuses.includes(p.status)) return p;
    if (Date.now() - t0 > ms) throw new Error(`proposal stuck in ${p.status}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe("approved collection through the workers", () => {
  it("runs to COMPLETED, records actual cost, and flows into search + graph", async () => {
    const p = await approved({ kind: "ADD_CHANNELS", channels: [{ youtubeId: FIXTURE_CHANNEL, aliases: [] }], maxVideosPerChannel: 300, includeTranscripts: true }, owner);
    await drain(240_000);
    const done = await waitFor(p.id, ["COMPLETED", "FAILED"]);
    expect(done.status).toBe("COMPLETED");
    expect(done.actualQuota).toBeGreaterThan(0);
    expect(done.actualSearchCalls).toBe(0);
    // Transcript fetches were registered as child jobs of the same approval and completed.
    expect(done.jobIds.some((j) => j.includes("-tx-"))).toBe(true);
    expect(done.doneJobIds.sort()).toEqual(done.jobIds.sort());
    expect(await db.transcript.count({ where: { visibility: "CORPUS" } })).toBeGreaterThan(0);
    // Downstream pipeline: embeddings, topics, graph node, search.
    const v = await db.video.findFirstOrThrow({ where: { channel: { youtubeId: FIXTURE_CHANNEL } }, orderBy: { viewCount: "desc" } });
    expect(await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int n FROM "Video" WHERE embedding IS NULL`).toEqual([{ n: 0 }]);
    expect(await db.graphNode.count({ where: { id: `channel:${FIXTURE_CHANNEL}` } })).toBe(1);
    const hits = await search({ q: v.title, mode: "keyword", types: ["video"], limit: 5 });
    expect(hits.items.some((h) => h.id === v.id)).toBe(true);
    const topic = await db.videoTopic.findFirstOrThrow({ where: { video: { channel: { youtubeId: FIXTURE_CHANNEL } } } });
    expect(topic.extractor).toBe("tfidf@1");
    expect((topic.evidence as { origin: string; fields: string[] }).origin).toBe("atlas-inferred");
  });

  it("discovery adds at most the approved number of new channels and refuses replays", async () => {
    const p = await approved(
      { kind: "DISCOVER_CHANNELS", queries: ["sourdough baking bread"], maxCandidatesPerQuery: 10, maxChannelsToAdd: 2, maxVideosPerChannel: 20, includeTranscripts: false },
      owner,
    );
    await drain(240_000);
    const done = await waitFor(p.id, ["COMPLETED", "FAILED"]);
    expect(done.status).toBe("COMPLETED");
    expect(await db.channel.count()).toBe(2);
    const results = done.actualResults as { selected: string[]; candidates: unknown[] };
    expect(results.selected).toHaveLength(2);
    expect(results.candidates.length).toBeGreaterThanOrEqual(2);
    expect(done.actualSearchCalls).toBe(1);
    expect(await db.video.count()).toBeLessThanOrEqual(40);
    // Replaying the (completed) discovery job is refused.
    await expect(ingestion.discoverChannelsApproved({ auth: authOf(p), lane: "interactive" }, ctlFor(p.jobIds[0]!))).rejects.toThrow(/completed/);
  });

  it("the worker refuses a forged job that bypassed the producer", async () => {
    const p = await approved({ kind: "ADD_CHANNELS", channels: [{ youtubeId: FIXTURE_CHANNEL, aliases: [] }], maxVideosPerChannel: 5, includeTranscripts: false }, owner);
    await drain(120_000);
    await waitFor(p.id, ["COMPLETED"]);
    const before = await db.channel.count();
    const forged = await getQueue(QUEUES.ingest).add("ingest-channel", { auth: authOf(p), lane: "interactive", youtubeId: "UCEuOyNcOAiA66JNfVjlPDS6" }, { jobId: "forged-1", attempts: 1 });
    await drain(60_000);
    expect(await forged.getState()).toBe("failed");
    expect((await getQueue(QUEUES.ingest).getJob("forged-1"))!.failedReason).toMatch(/completed|not registered/);
    expect(await db.channel.count()).toBe(before);
  });

  it("quota exhaustion delays an approved background job until reset (no attempt consumed)", async () => {
    const seed = await approved({ kind: "ADD_CHANNELS", channels: [{ youtubeId: FIXTURE_CHANNEL, aliases: [] }], maxVideosPerChannel: 5, includeTranscripts: false }, owner);
    await drain(120_000);
    await waitFor(seed.id, ["COMPLETED"]);
    await markExhausted("general");
    const p = await approved({ kind: "SYNC_UPLOADS", channelYoutubeIds: [FIXTURE_CHANNEL], maxNewVideosPerChannel: 5, includeTranscripts: false }, owner);
    const job = (await getQueue(QUEUES.sync).getJob(p.jobIds[0]!))!;
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
    expect((await db.expansionProposal.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("RUNNING");
    await fresh!.remove();
  });
});
