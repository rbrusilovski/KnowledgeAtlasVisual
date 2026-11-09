/**
 * Dynamic taxonomy over synthetic, already-"collected" corpus rows (vectors written directly), so the tests
 * exercise taxonomy logic — creation, reuse, growth, dedup, concurrency, provenance, manual overrides, graph
 * propagation and seed cleanup — independent of the ingestion pipeline. No YouTube calls happen anywhere here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { setVector } from "@/server/db/vector";
import { embeddingModelId } from "@/server/services/embeddings";
import { seedTaxonomy } from "@/server/services/classification";
import { classifyChannel } from "@/server/services/classification";
import { buildDirty, buildFromDirtySet } from "@/server/services/graph";
import * as tax from "@/server/services/taxonomy";
import { resetDb, flushRedis } from "./helpers";
import { closeQueues, getQueue, QUEUES } from "@/server/jobs";
import { redis } from "@/server/redis";

const D = 384;
/** Unit vector near basis `axis` with deterministic jitter (cos to centroid ≈ 0.95). */
function vec(axis: number, i: number, jitter = 0.12): number[] {
  const v = Array.from({ length: D }, (_, d) => (d === axis ? 1 : Math.sin(i * 12.9898 + d * 78.233) * jitter * (d < 40 ? 1 : 0)));
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

const THEMES = [
  { axis: 0, words: ["sourdough bread", "baking"], channel: "UCbake" },
  { axis: 5, words: ["kubernetes cluster", "devops"], channel: "UCdevops" },
  { axis: 10, words: ["marathon training", "running"], channel: "UCrun" },
];

async function addVideos(channelYt: string, axis: number, words: string[], n: number, offset = 0, prefix = "v") {
  const ch = await db.channel.upsert({ where: { youtubeId: channelYt }, create: { youtubeId: channelYt, title: `${channelYt} channel` }, update: {} });
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const v = await db.video.create({ data: { youtubeId: `${prefix}${channelYt}${offset + i}`, channelId: ch.id, title: `${words[0]} tips ${offset + i}`, tags: words, publishedAt: new Date(2024, 0, 1 + i) } });
    await setVector("Video", v.id, vec(axis, offset + i), { model: embeddingModelId() });
    ids.push(v.id);
  }
  return { channelId: ch.id, ids };
}

async function corpus() {
  for (const t of THEMES) await addVideos(t.channel, t.axis, t.words, 14);
}

const modeBefore = env.TAXONOMY_MODE;
beforeAll(() => {
  (env as { TAXONOMY_MODE: string }).TAXONOMY_MODE = "dynamic";
});
afterAll(async () => {
  (env as { TAXONOMY_MODE: string }).TAXONOMY_MODE = modeBefore;
  await getQueue(QUEUES.taxonomy).obliterate({ force: true }).catch(() => {});
  await closeQueues();
  await redis.quit();
  await db.$disconnect();
});
beforeEach(async () => {
  await resetDb();
  await flushRedis();
});

describe("dynamic taxonomy", () => {
  it("shadow mode plans categories from evidence and writes no taxonomy rows", async () => {
    await corpus();
    const r = await tax.bootstrapTaxonomy({ shadow: true });
    expect("plan" in r && r.plan).toBeTruthy();
    if (!("plan" in r) || !r.plan) return;
    expect(r.applied).toBe(false);
    const subs = r.plan.niches.flatMap((n) => n.subniches);
    expect(subs.length).toBeGreaterThanOrEqual(3);
    expect(subs.map((s) => s.name.toLowerCase()).join(" ")).toMatch(/sourdough|baking/);
    expect(await db.niche.count()).toBe(0);
    expect(await db.videoNiche.count()).toBe(0);
    expect((await db.taxonomyRun.findUniqueOrThrow({ where: { id: r.runId } })).kind).toBe("SHADOW");
  });

  it("apply creates DYNAMIC niches with provenance, projects channels and builds graph nodes", async () => {
    await corpus();
    const r = await tax.bootstrapTaxonomy({ shadow: false });
    if (!("dirty" in r) || !r.dirty) throw new Error("not applied");
    const niches = await db.niche.findMany({ where: { origin: "DYNAMIC" } });
    expect(niches.length).toBeGreaterThanOrEqual(4);
    expect(niches.every((n) => n.createdByRunId === r.runId && n.status === "ACTIVE")).toBe(true);
    const vn = await db.videoNiche.findMany();
    expect(new Set(vn.map((x) => x.videoId)).size).toBe(42);
    expect(vn.every((x) => x.runId === r.runId && x.promptVersion && x.taxonomyVersion === 1 && x.confidence > 0)).toBe(true);
    // every channel aggregates to exactly its theme's subniche
    const cn = await db.channelNiche.findMany({ include: { niche: true, channel: true } });
    expect(new Set(cn.map((c) => c.channelId)).size).toBe(3);
    for (const c of cn) expect(c.rationale).toMatch(/of \d+ videos/);
    await buildDirty(r.dirty);
    const nodes = await db.graphNode.findMany({ where: { type: { in: ["NICHE", "SUBNICHE"] } } });
    expect(nodes.length).toBe(niches.length);
    expect((nodes[0]!.attrs as { origin: string }).origin).toBe("atlas-inferred");
    expect(await db.graphEdge.count({ where: { kind: "IN_NICHE" } })).toBe(cn.length);
    // second apply without --rebuild is refused (no duplicate taxonomy)
    await expect(tax.bootstrapTaxonomy({ shadow: false })).rejects.toThrow(/already exists/);
  });

  it("new videos reuse the matching category; unrelated ones pool, then grow a new category with support", async () => {
    await corpus();
    await tax.bootstrapTaxonomy({ shadow: false });
    const subsBefore = await db.niche.count({ where: { origin: "DYNAMIC", depth: 1 } });
    const more = await addVideos("UCbake", 0, ["sourdough bread", "baking"], 3, 100);
    const r1 = await tax.classifyVideos(more.ids);
    expect(r1.reused).toBe(3);
    expect(r1.createdSubniches).toEqual([]);
    const bakeSub = (await db.videoNiche.findFirstOrThrow({ where: { videoId: more.ids[0] }, include: { niche: true } })).niche;
    expect((await db.videoNiche.findFirstOrThrow({ where: { videoId: more.ids[0] } })).decision).toBe("REUSE");
    // a new theme: below support → pooled, nothing created
    const chess1 = await addVideos("UCchess", 20, ["chess opening", "chess"], 2);
    const r2 = await tax.classifyVideos(chess1.ids);
    expect(r2.pooled).toBe(2);
    expect(r2.createdSubniches).toEqual([]);
    expect(await db.niche.count({ where: { origin: "DYNAMIC", depth: 1 } })).toBe(subsBefore);
    // a supported group with NO fitting niche is not forced under an unrelated one: it waits (regression: live test
    // put a 5-video "Cancer" group under "Neural Network")
    const chess2 = await addVideos("UCchess", 20, ["chess opening", "chess"], 3, 10);
    const r3a = await tax.classifyVideos(chess2.ids);
    expect(r3a.createdSubniches).toEqual([]);
    expect(r3a.pooled).toBe(3);
    // enough support for a new niche → one new niche + one subniche, founded by all pooled videos
    const chess3 = await addVideos("UCchess", 20, ["chess opening", "chess"], 6, 20);
    const r3 = await tax.classifyVideos(chess3.ids);
    expect(r3.createdNiches.length).toBe(1);
    expect(r3.createdSubniches.length).toBe(1);
    const created = await db.niche.findUniqueOrThrow({ where: { slug: r3.createdSubniches[0]! }, include: { videos: true, parent: true } });
    expect(created.origin).toBe("DYNAMIC");
    expect(created.parent!.slug).toBe(r3.createdNiches[0]);
    expect(created.videos.length).toBe(11);
    expect(created.videos.every((v) => v.decision === "CREATE")).toBe(true);
    expect(created.name.toLowerCase()).toMatch(/chess/);
    expect(bakeSub.id).not.toBe(created.id);
    // the new category reaches the graph through the dirty set
    await buildFromDirtySet();
    expect(await db.graphNode.findUnique({ where: { id: `subniche:${created.slug}` } })).not.toBeNull();
    expect((await db.channelNiche.findMany({ where: { channel: { youtubeId: "UCchess" } } })).map((c) => c.nicheId)).toEqual([created.id]);
  });

  it("concurrent classification never creates duplicate categories", async () => {
    await corpus();
    await tax.bootstrapTaxonomy({ shadow: false });
    const a = await addVideos("UCchess", 20, ["chess opening", "chess"], 6);
    const b = await addVideos("UCchess", 20, ["chess opening", "chess"], 6, 50);
    const results = await Promise.all([tax.classifyVideos(a.ids), tax.classifyVideos(b.ids), tax.classifyVideos([...a.ids, ...b.ids])]);
    expect(results.flatMap((r) => r.createdSubniches).length).toBe(1);
    expect(results.flatMap((r) => r.createdNiches).length).toBe(1);
    const chessNiches = await db.niche.findMany({ where: { origin: "DYNAMIC", depth: 1, videos: { some: { videoId: { in: a.ids } } } } });
    expect(chessNiches.length).toBe(1);
    expect(await db.videoNiche.count({ where: { videoId: { in: [...a.ids, ...b.ids] } } })).toBe(12);
  });

  it("manual channel assignments survive projection and classification", async () => {
    await corpus();
    await tax.bootstrapTaxonomy({ shadow: false });
    const ch = await db.channel.findUniqueOrThrow({ where: { youtubeId: "UCrun" } });
    const other = await db.niche.findFirstOrThrow({ where: { origin: "DYNAMIC", depth: 1, channels: { none: { channelId: ch.id } } } });
    await db.channelNiche.deleteMany({ where: { channelId: ch.id } });
    await db.channelNiche.create({ data: { channelId: ch.id, nicheId: other.id, confidence: 1, method: "MANUAL" } });
    await tax.projectChannels();
    await classifyChannel(ch.id); // dynamic mode delegates to projection
    const more = await addVideos("UCrun", 10, ["marathon training", "running"], 2, 200);
    await tax.classifyVideos(more.ids);
    const rows = await db.channelNiche.findMany({ where: { channelId: ch.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ nicheId: other.id, method: "MANUAL" });
  });

  it("is idle outside dynamic mode and never touches the seed taxonomy", async () => {
    (env as { TAXONOMY_MODE: string }).TAXONOMY_MODE = "seed";
    try {
      await corpus();
      expect((await tax.classifyVideos([])).skipped).toMatch(/not dynamic/);
    } finally {
      (env as { TAXONOMY_MODE: string }).TAXONOMY_MODE = "dynamic";
    }
  });
});

describe("demo taxonomy cleanup", () => {
  it("dry run is blocked until a dynamic taxonomy covers every channel; executes only the reviewed plan", async () => {
    const ids = await seedTaxonomy();
    expect(ids.length).toBeGreaterThan(0);
    const seedCount = await db.niche.count({ where: { origin: "SEED" } });
    await corpus();
    // user data pointing at a demo node is reported, never deleted
    const user = await db.user.create({ data: { id: "u-clean", name: "U", email: "u@clean.test" } });
    const ws = await db.workspace.create({ data: { name: "W", ownerId: user.id } });
    await db.nodeLayout.create({ data: { workspaceId: ws.id, nodeId: `subniche:${tax.SEED_MANIFEST.find((s) => s === "baking") ?? tax.SEED_MANIFEST[0]}`, x: 1, y: 2 } });

    const blocked = await tax.planSeedCleanup();
    expect(blocked.ready).toBe(false);
    expect(blocked.blockers.join(" ")).toMatch(/no active dynamic taxonomy/);
    await expect(tax.executeSeedCleanup(blocked.hash)).rejects.toThrow(/blocked/);

    await tax.bootstrapTaxonomy({ shadow: false });
    const plan = await tax.planSeedCleanup();
    expect(plan.ready).toBe(true);
    expect(plan.niches.length).toBe(seedCount);
    expect(plan.userReferences.nodeLayouts).toBe(1);
    expect(await db.niche.count({ where: { origin: "SEED" } })).toBe(seedCount); // dry run changed nothing

    await expect(tax.executeSeedCleanup("deadbeefdeadbeef")).rejects.toThrow(/changed since it was reviewed/);
    const done = await tax.executeSeedCleanup(plan.hash);
    expect(done.deleted).toBe(seedCount);
    expect(await db.niche.count({ where: { origin: "SEED" } })).toBe(0);
    expect(await db.niche.count({ where: { origin: "DYNAMIC" } })).toBeGreaterThan(0);
    expect(await db.video.count()).toBe(42);
    expect(await db.channel.count()).toBe(3);
    expect(await db.nodeLayout.count()).toBe(1);
    expect(await db.user.count({ where: { id: user.id } })).toBe(1);
    // demo nodes become graph tombstones
    await buildDirty(done.nodeIds);
    expect(await db.graphNode.count({ where: { id: { in: done.nodeIds } } })).toBe(0);
  });
});
