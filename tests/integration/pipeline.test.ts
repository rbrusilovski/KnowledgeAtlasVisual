import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Worker } from "bullmq";
import { db } from "@/server/db";
import { seedTaxonomy } from "@/server/services/classification";
import { embedEntities } from "@/server/services/embeddings";
import { getSubgraph, getDelta, currentVersion, relatedCreators, findPath } from "@/server/services/graph";
import { knn, getVector } from "@/server/db/vector";
import { GraphQuery } from "@/shared/contracts/graph";
import { startWorkers } from "@/worker/processors";
import { resetDb, flushRedis, drain, teardown, setServed, approved, makeUser } from "./helpers";

// Three channels: two baking-adjacent, one devops — enough for topics, niches, similarity and edges.
let channels: string[] = [];
let workers: Worker[] = [];
let owner: Awaited<ReturnType<typeof makeUser>>;

async function pickFixtureChannels() {
  const { readFileSync } = await import("node:fs");
  const idx = JSON.parse(readFileSync("fixtures/youtube/index.json", "utf8")) as { channels: { id: string; subniche: string }[] };
  const bySub = (s: string) => idx.channels.filter((c) => c.subniche === s).map((c) => c.id);
  return [...bySub("baking").slice(0, 1), ...bySub("recipes").slice(0, 1), ...bySub("devops-cloud").slice(0, 1)];
}

beforeAll(async () => {
  await resetDb();
  await flushRedis();
  const ids = await seedTaxonomy();
  await embedEntities("niche", ids);
  const { buildDirty } = await import("@/server/services/graph");
  const niches = await db.niche.findMany({ select: { slug: true, depth: true } });
  await buildDirty(niches.map((n) => `${n.depth === 0 ? "niche" : "subniche"}:${n.slug}`));
  workers = startWorkers();
  setServed(workers);
  channels = await pickFixtureChannels();
  owner = await makeUser("pipeline@atlas.test");
  await approved({ kind: "ADD_CHANNELS", channels: channels.map((youtubeId) => ({ youtubeId, aliases: [] })), maxVideosPerChannel: 300, includeTranscripts: true }, owner);
  await drain(240_000);
}, 300_000);

afterAll(async () => {
  await teardown(workers);
});

describe("intelligence + graph pipeline (fixture mode)", () => {
  it("embeds channels and videos; every channel gets ≥ 1 subniche with confidence", async () => {
    for (const yt of channels) {
      const c = await db.channel.findUniqueOrThrow({ where: { youtubeId: yt }, include: { niches: true } });
      expect(await getVector("Channel", c.id)).toHaveLength(384);
      expect(c.niches.length).toBeGreaterThanOrEqual(1);
      expect(c.niches[0]!.confidence).toBeGreaterThan(0);
    }
    expect(await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) n FROM "Video" WHERE embedding IS NULL`).toEqual([{ n: 0n }]);
  });

  it("classifies the devops fixture channel into the devops subniche", async () => {
    const c = await db.channel.findUniqueOrThrow({ where: { youtubeId: channels[2]! }, include: { niches: { include: { niche: true }, orderBy: { confidence: "desc" } } } });
    expect(c.niches.map((n) => n.niche.slug)).toContain("devops-cloud");
  });

  it("materializes topics (≥ 2 videos) and topic nodes", async () => {
    expect(await db.topic.count({ where: { videoCount: { gte: 2 } } })).toBeGreaterThan(10);
    expect(await db.graphNode.count({ where: { type: "TOPIC" } })).toBe(await db.topic.count({ where: { videoCount: { gte: 2 } } }));
  });

  it("semantic KNN returns sensible neighbors (videos cluster with their own channel's videos)", async () => {
    // Aggregate over several videos (deterministic order) so one atypical title can't make this flaky.
    const ch = await db.channel.findUniqueOrThrow({ where: { youtubeId: channels[2]! } });
    const sample = await db.video.findMany({ where: { channelId: ch.id, isShort: false }, orderBy: { youtubeId: "asc" }, take: 6 });
    let same = 0;
    let total = 0;
    for (const v of sample) {
      const vec = (await getVector("Video", v.id))!;
      const hits = await knn("Video", vec, 5, { excludeId: v.id });
      const owners = await db.video.findMany({ where: { id: { in: hits.map((h) => h.id) } }, select: { channelId: true } });
      same += owners.filter((o) => o.channelId === ch.id).length;
      total += owners.length;
    }
    // 4 channels are ingested, so chance level is ~25%; require a clear majority.
    expect(same / total).toBeGreaterThan(0.5);
  });

  it("builds structural and semantic edges", async () => {
    const kinds = await db.graphEdge.groupBy({ by: ["kind"], _count: true });
    const have = new Set(kinds.map((k) => k.kind));
    for (const k of ["CONTAINS", "IN_NICHE", "PUBLISHED", "MENTIONS", "CHANNEL_TOPIC", "NICHE_TOPIC", "TOPIC_RELATED"]) expect(have).toContain(k);
    // Undirected edges are canonical.
    const und = await db.graphEdge.findMany({ where: { kind: { in: ["SIMILAR", "CO_TOPIC", "TOPIC_RELATED"] } }, select: { sourceId: true, targetId: true } });
    expect(und.every((e) => e.sourceId < e.targetId)).toBe(true);
  });

  it("global subgraph has no videos and respects the node limit", async () => {
    const g = await getSubgraph(GraphQuery.parse({}));
    expect(g.nodes.some((n) => n.type === "VIDEO")).toBe(false);
    expect(g.nodes.filter((n) => n.type === "CHANNEL")).toHaveLength(3);
    const small = await getSubgraph(GraphQuery.parse({ limit: "20" }));
    expect(small.nodes.length).toBeLessThanOrEqual(20 + 60); // structural nodes are always kept
    expect(small.truncated).toBe(true);
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(g.edges.every((e) => ids.has(e.source) && ids.has(e.target))).toBe(true);
  });

  it("local traversal is bounded by depth, fan-out and limit", async () => {
    const focus = `channel:${channels[0]}`;
    const d1 = await getSubgraph(GraphQuery.parse({ mode: "local", focus, depth: "1" }));
    const d2 = await getSubgraph(GraphQuery.parse({ mode: "local", focus, depth: "2" }));
    expect(d1.nodes.length).toBeLessThanOrEqual(41);
    expect(d2.nodes.length).toBeGreaterThan(d1.nodes.length);
    const capped = await getSubgraph(GraphQuery.parse({ mode: "local", focus, depth: "3", limit: "25" }));
    expect(capped.nodes.length).toBeLessThanOrEqual(25);
    expect(capped.truncated).toBe(true);
    expect(d1.nodes.some((n) => n.type === "VIDEO")).toBe(true);
  });

  it("delta reports upserts after a new ingest", async () => {
    const before = BigInt(await currentVersion());
    const { readFileSync } = await import("node:fs");
    const idx = JSON.parse(readFileSync("fixtures/youtube/index.json", "utf8")) as { channels: { id: string; subniche: string }[] };
    const extra = idx.channels.find((c) => c.subniche === "baking" && !channels.includes(c.id)) ?? idx.channels.find((c) => !channels.includes(c.id))!;
    await approved({ kind: "ADD_CHANNELS", channels: [{ youtubeId: extra.id, aliases: [] }], maxVideosPerChannel: 300, includeTranscripts: true }, owner);
    await drain(240_000);
    const d = await getDelta(before);
    expect(BigInt(d.toVersion)).toBeGreaterThan(before);
    expect(d.nodes.some((n) => n.id === `channel:${extra.id}`)).toBe(true);
    expect(d.reset).toBe(false);
    channels.push(extra.id);
  });

  it("related creators come with human-readable reasons", async () => {
    const all = await Promise.all(channels.map((c) => relatedCreators(c)));
    const withReasons = all.flat().filter((r) => r.reasons.length);
    for (const r of withReasons) expect(r.reasons[0]!.text.length).toBeGreaterThan(5);
  });

  it("finds a path between two channels through the taxonomy/topics", async () => {
    const p = await findPath(`channel:${channels[0]}`, `channel:${channels[2]}`, 6);
    expect(p).not.toBeNull();
    expect(p!.nodes[0]!.id).toBe(`channel:${channels[0]}`);
    expect(p!.nodes.at(-1)!.id).toBe(`channel:${channels[2]}`);
  });
});


describe("search (fixture mode)", () => {
  it("keyword search finds channels and videos by title words with highlights", async () => {
    const { search } = await import("@/server/services/search");
    const ch = await db.channel.findUniqueOrThrow({ where: { youtubeId: channels[2]! } });
    const word = ch.title.split(" ").at(-1)!;
    const r = await search({ q: word, mode: "keyword", types: ["channel", "video"], limit: 10 });
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.some((i) => i.type === "channel" && i.id === ch.id)).toBe(true);
    const v = await db.video.findFirstOrThrow({ where: { channelId: ch.id, isShort: false }, orderBy: { publishedAt: "desc" } });
    const term = v.tags[0]!;
    const rv = await search({ q: term, mode: "keyword", types: ["video"], limit: 50 });
    expect(rv.items.some((i) => i.type === "video")).toBe(true);
  });

  it("semantic + hybrid search return typed results with node ids (graceful mode reporting)", async () => {
    const { search } = await import("@/server/services/search");
    const r = await search({ q: "kubernetes containers deployment", mode: "hybrid", types: ["channel", "video", "topic"], limit: 10 });
    expect(r.items.length).toBeGreaterThan(0);
    for (const i of r.items) expect(i.nodeId).toMatch(/^(channel|video|topic):/);
    expect(["hybrid", "keyword"]).toContain(r.effectiveMode);
    const sem = await search({ q: "kubernetes containers deployment", mode: "semantic", types: ["video"], limit: 5 });
    expect(sem.effectiveMode).toBe("semantic");
    expect(sem.items[0]!.meta?.channelNodeId).toBe(`channel:${channels[2]}`);
  });

  it("transcript hits group by video and deep-link to timestamps", async () => {
    const { search } = await import("@/server/services/search");
    const chunk = await db.transcriptChunk.findFirstOrThrow({ select: { text: true } });
    const phrase = chunk.text.split(/[.!?]/)[0]!.split(" ").filter((w) => w.length > 5).slice(0, 2).join(" ");
    const r = await search({ q: phrase, mode: "keyword", types: ["transcript"], limit: 10 });
    expect(r.items.length).toBeGreaterThan(0);
    const hit = r.items[0]!;
    expect(hit.type).toBe("transcript");
    expect(hit.chunks!.length).toBeGreaterThan(0);
    expect(hit.chunks![0]!.url).toMatch(/watch\?v=[\w-]{11}&t=\d+s$/);
  });

  it("semantic transcript hits carry real video node ids and titles", async () => {
    const { search } = await import("@/server/services/search");
    const r = await search({ q: "kubernetes cluster deployment", mode: "semantic", types: ["transcript"], limit: 5 });
    for (const h of r.items) {
      expect(h.nodeId).toMatch(/^video:[\w-]{11}$/);
      expect(h.title.length).toBeGreaterThan(0);
      expect(h.chunks![0]!.url).toMatch(/watch\?v=[\w-]{11}&t=\d+s$/);
    }
  });

  it("channel-scoped search applies filters and facets", async () => {
    const { channelVideos } = await import("@/server/services/search");
    const { ChannelVideosQuery } = await import("@/shared/contracts/channels");
    const ch = await db.channel.findUniqueOrThrow({ where: { youtubeId: channels[0]! } });
    const all = await channelVideos(ch.id, ChannelVideosQuery.parse({ limit: "100" }));
    expect(all.facets.total).toBe(await db.video.count({ where: { channelId: ch.id } }));
    expect(all.items.every((i) => i.meta?.channelNodeId === `channel:${channels[0]}`)).toBe(true);
    const shorts = await channelVideos(ch.id, ChannelVideosQuery.parse({ duration: "short" }));
    expect(shorts.items.length).toBe(Math.min(25, all.facets.duration.short));
    const tx = await channelVideos(ch.id, ChannelVideosQuery.parse({ hasTranscript: "true" }));
    expect(tx.items.every((i) => i.meta?.hasTranscript === true)).toBe(true);
    const v = await db.video.findFirstOrThrow({ where: { channelId: ch.id } });
    const q = await channelVideos(ch.id, ChannelVideosQuery.parse({ q: v.title.split(" ").slice(0, 3).join(" ") }));
    expect(q.items.every((i) => i.meta?.channelNodeId === `channel:${channels[0]}`)).toBe(true);
  });

  it("suggest returns fuzzy prefix matches fast", async () => {
    const { suggest } = await import("@/server/services/search");
    const ch = await db.channel.findUniqueOrThrow({ where: { youtubeId: channels[0]! } });
    const t0 = performance.now();
    const items = await suggest(ch.title.slice(0, 5));
    const ms = performance.now() - t0;
    expect(items.some((i) => i.type === "channel" && i.id === ch.id)).toBe(true);
    expect(ms).toBeLessThan(250); // includes connection warm-up; warm path measured in the API below 50 ms
    const typo = await suggest(ch.title.slice(0, 6).replace(/.$/, "x"));
    expect(Array.isArray(typo)).toBe(true);
  });
});

describe("suggested subniches", () => {
  it("clusters low-confidence channels, accepts a suggestion and reclassifies members", async () => {
    const { suggestSubniches, acceptSubnicheSuggestion, dismissSuggestion } = await import("@/server/services/classification");
    // Make every channel a weak fit so they become candidates.
    await db.channelNiche.updateMany({ data: { confidence: 0.2, lowConfidence: true } });
    const suggestions = await suggestSubniches({ minClusterSize: 2, minSimilarity: -1 });
    expect(suggestions.length).toBeGreaterThan(0);
    const s = suggestions[0]!;
    expect(s.channels.length).toBeGreaterThanOrEqual(2);
    expect(s.id).toMatch(/^[a-f0-9]{12}$/);

    const parent = await db.niche.findFirstOrThrow({ where: { depth: 0 } });
    const niche = await acceptSubnicheSuggestion({ channelIds: s.channels.map((c) => c.id), name: "Test Cluster Niche", parentSlug: parent.slug, keywords: s.keywords });
    const created = await db.niche.findUniqueOrThrow({ where: { slug: niche.slug }, include: { channels: true } });
    expect(created.depth).toBe(1);
    expect(created.parentId).toBe(parent.id);
    expect(created.channels.length).toBe(s.channels.length);
    const rows = await db.$queryRaw<{ has: boolean }[]>`SELECT centroid IS NOT NULL AS has FROM "Niche" WHERE id = ${created.id}`;
    expect(rows[0]?.has).toBe(true);
    await drain();
    expect(await db.graphNode.findUnique({ where: { id: `subniche:${niche.slug}` } })).not.toBeNull();

    // Accepted / dismissed suggestions don't come back.
    const again = await suggestSubniches({ minClusterSize: 2, minSimilarity: -1 });
    expect(again.find((x) => x.id === s.id)).toBeUndefined();
    for (const x of again) await dismissSuggestion(x.id);
    expect(await suggestSubniches({ minClusterSize: 2, minSimilarity: -1 })).toEqual([]);
  });
});
