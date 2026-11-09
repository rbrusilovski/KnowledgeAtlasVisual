import { db, Prisma } from "@/server/db";
import { redis, key } from "@/server/redis";
import { enqueue } from "@/server/jobs";
import { log } from "@/server/logger";
import { knn } from "@/server/db/vector";
import { embedTexts } from "@/server/services/embeddings";
import { candidateFrequencies, topPhrases, slugify } from "./text";

export * from "./text";

const DF_KEY = () => key("topics", "df");
const NDOCS_KEY = () => key("topics", "ndocs");
const DOC_KEY = (videoId: string) => key("topics", "doc", videoId);

export const TOPICS_PER_VIDEO = 8;
export const MIN_VIDEOS_FOR_NODE = 2;
const TRGM_MERGE = 0.8;
const EMB_MERGE = 0.9;

/** Update corpus document frequencies for one video (diff against its previous candidate set). */
async function updateDf(videoId: string, phrases: string[]) {
  const prev = new Set(await redis.smembers(DOC_KEY(videoId)));
  const next = new Set(phrases);
  const pipe = redis.multi();
  if (!prev.size) pipe.incr(NDOCS_KEY());
  for (const p of next) if (!prev.has(p)) pipe.hincrby(DF_KEY(), p, 1);
  for (const p of prev) if (!next.has(p)) pipe.hincrby(DF_KEY(), p, -1);
  pipe.del(DOC_KEY(videoId));
  if (next.size) pipe.sadd(DOC_KEY(videoId), ...next);
  await pipe.exec();
}

/** Resolve a normalized phrase to a canonical Topic id: exact slug/alias → trigram ≥ 0.8 → embedding ≥ 0.9 → create. */
const RESOLVE_KEY = (label: string) => key("topics", "resolve", label);

export async function canonicalize(label: string, cache = new Map<string, string>()): Promise<{ id: string; created: boolean }> {
  const hit = cache.get(label) ?? (await redis.get(RESOLVE_KEY(label)));
  if (hit) {
    cache.set(label, hit);
    return { id: hit, created: false };
  }
  const r = await canonicalizeUncached(label, cache);
  await redis.set(RESOLVE_KEY(label), r.id, "EX", 7 * 86400);
  return r;
}

async function canonicalizeUncached(label: string, cache: Map<string, string>): Promise<{ id: string; created: boolean }> {
  const slug = slugify(label);
  const exact = await db.topic.findFirst({ where: { OR: [{ slug }, { aliases: { has: label } }] }, select: { id: true } });
  if (exact) {
    cache.set(label, exact.id);
    return { id: exact.id, created: false };
  }
  const trgm = await db.$queryRaw<{ id: string; label: string; s: number }[]>`
    SELECT id, label, similarity(label, ${label}) AS s FROM "Topic"
    WHERE label % ${label} ORDER BY s DESC LIMIT 1`;
  let target = trgm[0] && trgm[0].s >= TRGM_MERGE ? trgm[0].id : null;
  if (!target) {
    const [vec] = await embedTexts([label]);
    const near = vec ? await knn("Topic", vec, 1) : [];
    if (near[0] && near[0].similarity >= EMB_MERGE) target = near[0].id;
  }
  if (target) {
    await db.$executeRaw`UPDATE "Topic" SET aliases = array_append(aliases, ${label}) WHERE id = ${target} AND NOT (${label} = ANY(aliases))`;
    cache.set(label, target);
    return { id: target, created: false };
  }
  try {
    const t = await db.topic.create({ data: { slug, label, aliases: [label] }, select: { id: true } });
    cache.set(label, t.id);
    return { id: t.id, created: true };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const t = await db.topic.findUniqueOrThrow({ where: { slug }, select: { id: true } });
      cache.set(label, t.id);
      return { id: t.id, created: false };
    }
    throw e;
  }
}

export async function recomputeTopicCounts(topicIds: string[]) {
  if (!topicIds.length) return;
  await db.$executeRaw`
    UPDATE "Topic" t SET "videoCount" = COALESCE(s.vc, 0), "channelCount" = COALESCE(s.cc, 0)
    FROM (SELECT id FROM "Topic" WHERE id = ANY(${topicIds})) ids
    LEFT JOIN (
      SELECT vt."topicId", count(*)::int AS vc, count(DISTINCT v."channelId")::int AS cc
      FROM "VideoTopic" vt JOIN "Video" v ON v.id = vt."videoId"
      WHERE vt."topicId" = ANY(${topicIds}) GROUP BY vt."topicId"
    ) s ON s."topicId" = ids.id
    WHERE t.id = ids.id`;
}

export interface ExtractResult {
  videos: number;
  topicsCreated: number;
  links: number;
}

/** TF-IDF keyphrases → canonical topics → VideoTopic (source "tfidf"). AI-sourced links are preserved. */
export async function extractTopics(videoIds: string[]): Promise<ExtractResult> {
  const videos = await db.video.findMany({
    where: { id: { in: videoIds } },
    select: {
      id: true,
      youtubeId: true,
      title: true,
      tags: true,
      description: true,
      channel: { select: { youtubeId: true } },
      transcript: { select: { chunks: { orderBy: { idx: "asc" }, take: 8, select: { text: true } } } },
    },
  });
  const perVideo = new Map<string, Map<string, number>>();
  for (const v of videos) {
    const tf = candidateFrequencies({ title: v.title, tags: v.tags, description: v.description, transcript: v.transcript?.chunks.map((c) => c.text) });
    perVideo.set(v.id, tf);
    await updateDf(v.id, [...tf.keys()]);
  }
  const nDocs = Number((await redis.get(NDOCS_KEY())) ?? 1);
  const allPhrases = [...new Set([...perVideo.values()].flatMap((m) => [...m.keys()]))];
  const dfVals = allPhrases.length ? await redis.hmget(DF_KEY(), ...allPhrases) : [];
  const dfMap = new Map(allPhrases.map((p, i) => [p, Number(dfVals[i] ?? 0)]));

  const cache = new Map<string, string>();
  const created: string[] = [];
  const affected = new Set<string>();
  let links = 0;
  for (const v of videos) {
    const top = topPhrases(perVideo.get(v.id)!, (p) => dfMap.get(p) ?? 0, nDocs, TOPICS_PER_VIDEO);
    const max = top[0]?.score ?? 1;
    const weights = new Map<string, number>();
    for (const t of top) {
      const c = await canonicalize(t.phrase, cache);
      if (c.created) created.push(c.id);
      weights.set(c.id, Math.max(weights.get(c.id) ?? 0, +(t.score / max).toFixed(4)));
    }
    const prev = await db.videoTopic.findMany({ where: { videoId: v.id, source: "tfidf" }, select: { topicId: true, weight: true } });
    const same = prev.length === weights.size && prev.every((p) => Math.abs((weights.get(p.topicId) ?? -1) - p.weight) < 1e-4);
    if (!same) {
      await db.$transaction([
        db.videoTopic.deleteMany({ where: { videoId: v.id, source: "tfidf" } }),
        db.videoTopic.createMany({ data: [...weights].map(([topicId, weight]) => ({ videoId: v.id, topicId, weight, source: "tfidf" })), skipDuplicates: true }),
      ]);
      prev.forEach((p) => affected.add(p.topicId));
      weights.forEach((_w, id) => affected.add(id));
    }
    links += weights.size;
  }
  await db.video.updateMany({ where: { id: { in: videoIds } }, data: { topicsAt: new Date() } });
  await recomputeTopicCounts([...affected]);
  if (created.length) await enqueue.embed("topic", created);
  if (affected.size) {
    const topics = await db.topic.findMany({ where: { id: { in: [...affected] } }, select: { slug: true } });
    const dirty = [...topics.map((t) => `topic:${t.slug}`), ...videos.map((v) => `video:${v.youtubeId}`), ...new Set(videos.map((v) => `channel:${v.channel.youtubeId}`))];
    await enqueue.graph(dirty);
  }
  log().debug({ videos: videos.length, created: created.length, affected: affected.size }, "topics extracted");
  return { videos: videos.length, topicsCreated: created.length, links };
}

/** Merge AI-extracted topic labels into a video's topics (source "ai"). */
export async function applyAiTopics(videoId: string, labels: { label: string; weight: number }[]) {
  const { normalizePhrase } = await import("./text");
  const cache = new Map<string, string>();
  const rows: { topicId: string; weight: number }[] = [];
  const created: string[] = [];
  for (const l of labels.slice(0, 10)) {
    const label = normalizePhrase(l.label);
    if (!label || label.split(" ").length > 4) continue;
    const c = await canonicalize(label, cache);
    if (c.created) created.push(c.id);
    rows.push({ topicId: c.id, weight: Math.max(0, Math.min(1, l.weight)) });
  }
  const prev = await db.videoTopic.findMany({ where: { videoId, source: "ai" }, select: { topicId: true } });
  await db.$transaction([
    db.videoTopic.deleteMany({ where: { videoId, source: "ai" } }),
    db.videoTopic.createMany({ data: rows.map((r) => ({ videoId, ...r, source: "ai" })), skipDuplicates: true }),
  ]);
  const affected = [...new Set([...prev.map((p) => p.topicId), ...rows.map((r) => r.topicId)])];
  await recomputeTopicCounts(affected);
  if (created.length) await enqueue.embed("topic", created);
  const topics = await db.topic.findMany({ where: { id: { in: affected } }, select: { slug: true } });
  await enqueue.graph(topics.map((t) => `topic:${t.slug}`));
}

export async function listTopics(opts: { q?: string; limit: number; offset: number; minVideos?: number }) {
  const where: Prisma.TopicWhereInput = { videoCount: { gte: opts.minVideos ?? MIN_VIDEOS_FOR_NODE } };
  if (opts.q) where.OR = [{ label: { contains: opts.q.toLowerCase() } }, { aliases: { has: opts.q.toLowerCase() } }];
  return db.topic.findMany({ where, orderBy: [{ videoCount: "desc" }, { id: "asc" }], skip: opts.offset, take: opts.limit, select: { id: true, slug: true, label: true, aliases: true, videoCount: true, channelCount: true } });
}
