/** Plan Phase 6 / D4, D5, D6, D12: embedding vector-space tracking + reindex, graph verify/repair, alert registry. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, readOnly } from "@/server/db";
import { redis, key } from "@/server/redis";
import { env } from "@/server/env";
import { knn, getVector } from "@/server/db/vector";
import * as ingestion from "@/server/services/ingestion";
import { seedTaxonomy } from "@/server/services/classification";
import { embedEntities, embedQuery, embeddingModelId, embeddingSpace, invalidateEmbeddingSpace, reindexEmbeddings } from "@/server/services/embeddings";
import { extractTopics } from "@/server/services/topics";
import { rebuildAll, verifyGraph } from "@/server/services/graph";
import { search } from "@/server/services/search";
import { evaluateAlerts, emitAlertEvents } from "@/server/services/alerts";
import { approved, authOf, ctlFor, flushRedis, makeUser, resetDb, teardown, FIXTURE_CHANNEL } from "./helpers";

let channelId: string;
let videoIds: string[];

async function markStale(n: number) {
  const rows = await db.video.findMany({ where: { channelId }, orderBy: { id: "asc" }, take: n, select: { id: true } });
  await db.$executeRawUnsafe(`UPDATE "Video" SET "embeddingModel" = 'local:some-other-model@384' WHERE id = ANY($1)`, rows.map((r) => r.id));
  invalidateEmbeddingSpace();
  return rows.map((r) => r.id);
}

beforeAll(async () => {
  await resetDb();
  await flushRedis();
  await seedTaxonomy();
  await embedEntities("niche", (await db.niche.findMany({ select: { id: true } })).map((n) => n.id));
  const user = await makeUser("ops@atlas.test");
  const p = await approved({ kind: "ADD_CHANNELS", channels: [{ youtubeId: FIXTURE_CHANNEL, aliases: [] }], maxVideosPerChannel: 12, includeTranscripts: false }, user);
  await ingestion.ingestChannel({ auth: authOf(p), lane: "interactive", youtubeId: FIXTURE_CHANNEL }, ctlFor(p.jobIds[0]!));
  channelId = (await db.channel.findUniqueOrThrow({ where: { youtubeId: FIXTURE_CHANNEL } })).id;
  videoIds = (await db.video.findMany({ where: { channelId }, select: { id: true } })).map((v) => v.id);
  await embedEntities("video", videoIds);
  await embedEntities("channel", [channelId]);
  await extractTopics(videoIds);
  await rebuildAll();
  invalidateEmbeddingSpace();
}, 180_000);
afterAll(async () => teardown());

describe("embedding vector space (D4)", () => {
  it("records the model on every stored vector and starts consistent", async () => {
    const s = await embeddingSpace({ fresh: true });
    expect(s.model).toBe(embeddingModelId());
    expect(s.model).toBe(`hash@${env.EMBEDDING_DIM}`);
    expect(Object.values(s.columns).every((d) => d === env.EMBEDDING_DIM)).toBe(true);
    expect(s.blocked).toBe(false);
    const rows = await db.$queryRaw<{ m: string | null }[]>`SELECT DISTINCT "embeddingModel" AS m FROM "Video" WHERE embedding IS NOT NULL`;
    expect(rows).toEqual([{ m: s.model }]);
  });

  it("never compares vectors from different models: semantic features switch off while the space is mixed", async () => {
    await markStale(2);
    const s = await embeddingSpace();
    expect(s.blocked).toBe(true);
    expect(s.stale.Video).toBe(2);
    expect(await embedQuery("kubernetes")).toBeNull();
    const r = await search({ q: "machine learning", mode: "semantic", types: ["video"], limit: 5 });
    expect(r.effectiveMode).toBe("keyword");
    expect(await embedEntities("video", videoIds)).toEqual({ embedded: 0, skipped: videoIds.length });
    expect((await evaluateAlerts()).map((a) => a.id)).toContain("embedding-space");
  });

  it("reindex re-embeds only stale rows and restores the space", async () => {
    const r = await reindexEmbeddings();
    expect(r.totals.video).toBe(2);
    expect(r.totals.channel).toBe(0);
    expect(r.space.blocked).toBe(false);
    expect(await embedQuery("kubernetes")).not.toBeNull();
  });

  it("is resumable: an interrupted run continues where it stopped", async () => {
    await markStale(4);
    let batches = 0;
    await expect(
      reindexEmbeddings({
        batch: 1,
        onProgress: () => {
          if (++batches === 2) throw new Error("simulated crash");
        },
      }),
    ).rejects.toThrow("simulated crash");
    invalidateEmbeddingSpace();
    expect((await embeddingSpace({ fresh: true })).stale.Video).toBe(2);
    const r = await reindexEmbeddings();
    expect(r.totals.video).toBe(2);
    expect(r.space.stale.Video).toBe(0);
    expect(r.space.blocked).toBe(false);
  });
});

describe("read-only scope still allows KNN tuning", () => {
  it("SET LOCAL hnsw.ef_search inside a read-only scope is not a write", async () => {
    const vec = (await getVector("Video", videoIds[0]!))!;
    const hits = await readOnly("t", () => knn("Video", vec, 3, { efSearch: 80 }));
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe("graph verification (D5)", () => {
  it("reports a consistent graph after a rebuild", async () => {
    const r = await verifyGraph();
    expect(r.missingNodes).toEqual([]);
    expect(r.danglingEdges).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("detects drift and repairs it", async () => {
    const channelNode = `channel:${FIXTURE_CHANNEL}`;
    await db.graphNode.delete({ where: { id: channelNode } });
    await db.graphNode.create({ data: { id: "topic:no-such-topic-zz", type: "TOPIC", refId: "no-such-topic-zz", label: "ghost", version: 1n } });
    const video = await db.graphNode.findFirstOrThrow({ where: { type: "VIDEO" }, select: { id: true } });
    await db.graphEdge.create({ data: { id: `MENTIONS|${video.id}|topic:missing-node`, sourceId: video.id, targetId: "topic:missing-node", kind: "MENTIONS", weight: 0.5, version: 1n } });
    const bad = await verifyGraph();
    expect(bad.ok).toBe(false);
    expect(bad.missingNodes).toContain(channelNode);
    expect(bad.orphanNodes).toContain("topic:no-such-topic-zz");
    expect(bad.danglingEdges.length).toBeGreaterThan(0);
    const fixed = await verifyGraph({ repair: true });
    expect(fixed.repaired).toBeDefined();
    const after = await verifyGraph();
    expect(after.ok).toBe(true);
    expect(await db.graphNode.findUnique({ where: { id: channelNode } })).not.toBeNull();
    expect(await db.graphTombstone.count({ where: { refId: "topic:no-such-topic-zz" } })).toBe(1);
  });
});

describe("alert registry (D6, D12)", () => {
  it("raises worker-down, stale-graph and (in development, informational) backup alerts", async () => {
    await redis.del(`${env.REDIS_PREFIX}:worker:heartbeat`);
    await redis.set(key("graph", "dirty-since"), String(Date.now() - 2 * 3600_000));
    await redis.sadd(key("graph", "dirty"), `channel:${FIXTURE_CHANNEL}`);
    const alerts = await evaluateAlerts();
    const byId = new Map(alerts.map((a) => [a.id, a]));
    expect(byId.get("worker-down")?.severity).toBe("critical");
    expect(byId.get("graph-stale")?.severity).toBe("critical");
    expect(byId.get("backup-missing")?.severity).toBe("info");
    expect(byId.get("restore-untested")?.severity).toBe("info");
    expect(alerts[0]!.severity).toBe("critical");
  });

  it("flags backups that failed after the last success, and clears when healthy", async () => {
    await redis.set(key("ops", "backup", "last-success"), JSON.stringify({ at: new Date(Date.now() - 3600_000).toISOString(), ok: true, offHost: true }));
    await redis.set(key("ops", "backup", "last-failure"), JSON.stringify({ at: new Date().toISOString(), ok: false, error: "disk full" }));
    expect((await evaluateAlerts()).find((a) => a.id === "backup-failed")?.detail).toBe("disk full");
    await redis.set(key("ops", "backup", "last-success"), JSON.stringify({ at: new Date().toISOString(), ok: true, offHost: true }));
    await redis.set(key("ops", "restore-test", "last-success"), JSON.stringify({ at: new Date().toISOString(), ok: true }));
    const ids = (await evaluateAlerts()).map((a) => a.id);
    expect(ids).not.toContain("backup-failed");
    expect(ids).not.toContain("backup-on-host");
    expect(ids).not.toContain("restore-untested");
  });

  it("emits structured alert events only when something changes", async () => {
    const first = await emitAlertEvents();
    expect(first.active).toBeGreaterThan(0);
    expect((await emitAlertEvents()).changed).toBe(0);
    await redis.set(`${env.REDIS_PREFIX}:worker:heartbeat`, String(Date.now()), "EX", 60);
    expect((await emitAlertEvents()).changed).toBeGreaterThan(0);
  });
});
