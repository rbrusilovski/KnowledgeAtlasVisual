import { db, type Prisma } from "@/server/db";
import { AppError, notFound } from "@/server/errors";
import { enqueue } from "@/server/jobs";
import { decodeCursor, encodeCursor } from "@/server/http/cursor";
import { resolveChannelInput } from "@/server/youtube/resolve";
import type { AddChannelResult } from "@/shared/contracts/jobs";
import type { ChannelSummary } from "@/shared/contracts/channels";
import type { z } from "zod";
import type { ChannelListQuery } from "@/shared/contracts/channels";

export { discoverChannels, discoverNiche, type DiscoveredChannel, type DiscoveryResult } from "./discovery";

const num = (v: bigint | number | null | undefined) => (v === null || v === undefined ? null : Number(v));

export async function addChannel(input: string, opts: { confirm?: boolean; userId?: string }): Promise<AddChannelResult> {
  const r = await resolveChannelInput(input, { confirmSearch: opts.confirm });
  if (r.status === "invalid") throw new AppError("VALIDATION_ERROR", r.reason);
  if (r.status === "notFound") throw new AppError("NOT_FOUND", r.reason);
  if (r.status === "needsConfirmation") {
    throw new AppError("NEEDS_CONFIRMATION", r.reason, { needsConfirmation: { cost: r.cost }, query: r.query });
  }
  const existing = await db.channel.findUnique({ where: { youtubeId: r.youtubeId }, select: { id: true, title: true, youtubeId: true } });
  if (existing) {
    return { status: "exists", youtubeId: r.youtubeId, channel: { id: existing.id, title: existing.title, nodeId: `channel:${existing.youtubeId}` } };
  }
  const job = await enqueue.ingest({ youtubeId: r.youtubeId, requestedBy: opts.userId, aliases: r.aliases, lane: "interactive" });
  return { status: "queued", youtubeId: r.youtubeId, channel: null, jobId: job.id };
}

export const channelSummarySelect = {
  id: true,
  youtubeId: true,
  title: true,
  handle: true,
  thumbnailUrl: true,
  subscriberCount: true,
  videoCount: true,
  viewCount: true,
  latestVideoAt: true,
  lastSyncedAt: true,
  niches: {
    orderBy: { confidence: "desc" },
    select: { confidence: true, method: true, lowConfidence: true, niche: { select: { id: true, slug: true, name: true } } },
  },
} satisfies Prisma.ChannelSelect;

type SummaryRow = Prisma.ChannelGetPayload<{ select: typeof channelSummarySelect }>;

export function toSummary(c: SummaryRow): ChannelSummary {
  return {
    id: c.id,
    youtubeId: c.youtubeId,
    nodeId: `channel:${c.youtubeId}`,
    title: c.title,
    handle: c.handle,
    thumbnailUrl: c.thumbnailUrl,
    subscriberCount: num(c.subscriberCount),
    videoCount: c.videoCount,
    viewCount: num(c.viewCount),
    latestVideoAt: c.latestVideoAt?.toISOString() ?? null,
    lastSyncedAt: c.lastSyncedAt?.toISOString() ?? null,
    niches: c.niches.map((n) => ({ ...n.niche, confidence: n.confidence, method: n.method, lowConfidence: n.lowConfidence })),
  };
}

export async function listChannels(q: z.infer<typeof ChannelListQuery>) {
  const offset = decodeCursor<{ o: number }>(q.cursor)?.o ?? 0;
  const where: Prisma.ChannelWhereInput = { isAvailable: true };
  if (q.niche) {
    const niche = await db.niche.findFirst({ where: { OR: [{ id: q.niche }, { slug: q.niche }] }, select: { id: true, depth: true } });
    if (!niche) throw notFound("Niche");
    where.niches = { some: niche.depth === 0 ? { niche: { parentId: niche.id } } : { nicheId: niche.id } };
  }
  if (q.minSubscribers !== undefined || q.maxSubscribers !== undefined) {
    where.subscriberCount = { gte: q.minSubscribers !== undefined ? BigInt(q.minSubscribers) : undefined, lte: q.maxSubscribers !== undefined ? BigInt(q.maxSubscribers) : undefined };
  }
  if (q.q) where.OR = [{ title: { contains: q.q, mode: "insensitive" } }, { handle: { contains: q.q.toLowerCase() } }];
  const orderBy: Prisma.ChannelOrderByWithRelationInput[] =
    q.sort === "recent"
      ? [{ latestVideoAt: { sort: "desc", nulls: "last" } }]
      : q.sort === "synced"
        ? [{ lastSyncedAt: { sort: "desc", nulls: "last" } }]
        : q.sort === "title"
        ? [{ title: "asc" }]
        : q.sort === "videos"
          ? [{ videoCount: { sort: "desc", nulls: "last" } }]
          : [{ subscriberCount: { sort: "desc", nulls: "last" } }];
  orderBy.push({ id: "asc" });
  const rows = await db.channel.findMany({ where, orderBy, skip: offset, take: q.limit + 1, select: channelSummarySelect });
  const hasMore = rows.length > q.limit;
  return { items: rows.slice(0, q.limit).map(toSummary), nextCursor: hasMore ? encodeCursor({ o: offset + q.limit }) : null };
}

/** Accepts our cuid, a UC… id or a node id. */
export async function findChannelId(idOrYoutubeId: string): Promise<string> {
  const yt = idOrYoutubeId.startsWith("channel:") ? idOrYoutubeId.slice(8) : idOrYoutubeId;
  const c = await db.channel.findFirst({ where: { OR: [{ id: yt }, { youtubeId: yt }] }, select: { id: true } });
  if (!c) throw notFound("Channel");
  return c.id;
}

export async function findVideoId(idOrYoutubeId: string): Promise<string> {
  const yt = idOrYoutubeId.startsWith("video:") ? idOrYoutubeId.slice(6) : idOrYoutubeId;
  const v = await db.video.findFirst({ where: { OR: [{ id: yt }, { youtubeId: yt }] }, select: { id: true } });
  if (!v) throw notFound("Video");
  return v.id;
}

// ── Detail DTOs ────────────────────────────────────────────────────────────

export async function channelDetail(id: string) {
  const c = await db.channel.findUnique({
    where: { id },
    select: {
      ...channelSummarySelect,
      description: true,
      customUrl: true,
      country: true,
      publishedAt: true,
      keywords: true,
      topicCategories: true,
      syncTier: true,
      lastSyncedAt: true,
      lastRefreshedAt: true,
      backfillPageToken: true,
      featuredChannelIds: true,
      isAvailable: true,
      niches: { orderBy: { confidence: "desc" }, select: { confidence: true, method: true, lowConfidence: true, rationale: true, niche: { select: { id: true, slug: true, name: true, parent: { select: { slug: true, name: true } } } } } },
    },
  });
  if (!c) throw notFound("Channel");
  const topics = await db.$queryRaw<{ id: string; slug: string; label: string; w: number; videos: number }[]>`
    SELECT t.id, t.slug, t.label, sum(vt.weight)::float AS w, count(*)::int AS videos
    FROM "VideoTopic" vt JOIN "Video" v ON v.id = vt."videoId" JOIN "Topic" t ON t.id = vt."topicId"
    WHERE v."channelId" = ${id} AND t."videoCount" >= 2 GROUP BY t.id, t.slug, t.label ORDER BY w DESC LIMIT 20`;
  const latest = await db.video.findMany({ where: { channelId: id, isAvailable: true }, orderBy: { publishedAt: "desc" }, take: 6, select: { id: true, youtubeId: true, title: true, thumbnailUrl: true, publishedAt: true, viewCount: true, durationSec: true, hasTranscript: true } });
  const lastRun = await db.ingestionRun.findFirst({ where: { targetId: c.youtubeId, status: "completed" }, orderBy: { startedAt: "desc" }, select: { kind: true, startedAt: true, finishedAt: true, unitsUsed: true, searchCalls: true, stats: true } });
  const transcriptCount = await db.video.count({ where: { channelId: id, hasTranscript: true } });
  return {
    ...toSummary(c as unknown as SummaryRow),
    description: c.description,
    customUrl: c.customUrl,
    country: c.country,
    publishedAt: c.publishedAt?.toISOString() ?? null,
    keywords: c.keywords,
    topicCategories: c.topicCategories,
    syncTier: c.syncTier,
    lastSyncedAt: c.lastSyncedAt?.toISOString() ?? null,
    hasMoreHistory: Boolean(c.backfillPageToken),
    featuredCount: c.featuredChannelIds.length,
    transcriptCount,
    url: `https://www.youtube.com/channel/${c.youtubeId}`,
    niches: c.niches.map((n) => ({ id: n.niche.id, slug: n.niche.slug, name: n.niche.name, parent: n.niche.parent, confidence: n.confidence, method: n.method, lowConfidence: n.lowConfidence, rationale: n.rationale })),
    topics: topics.map((t) => ({ id: t.id, nodeId: `topic:${t.slug}`, slug: t.slug, label: t.label, weight: +t.w.toFixed(3), videos: t.videos })),
    latestVideos: latest.map((v) => ({ ...v, nodeId: `video:${v.youtubeId}`, viewCount: num(v.viewCount), publishedAt: v.publishedAt.toISOString() })),
    lastRun: lastRun && { ...lastRun, startedAt: lastRun.startedAt.toISOString(), finishedAt: lastRun.finishedAt?.toISOString() ?? null },
  };
}

export async function videoDetail(id: string) {
  const v = await db.video.findUnique({
    where: { id },
    select: {
      id: true, youtubeId: true, title: true, description: true, publishedAt: true, durationSec: true, tags: true, categoryId: true, defaultLanguage: true,
      thumbnailUrl: true, viewCount: true, likeCount: true, commentCount: true, isShort: true, hasTranscript: true, lastRefreshedAt: true,
      channel: { select: { id: true, youtubeId: true, title: true, handle: true, thumbnailUrl: true, subscriberCount: true } },
      topics: { orderBy: { weight: "desc" }, select: { weight: true, source: true, topic: { select: { id: true, slug: true, label: true, videoCount: true } } } },
      transcript: { select: { source: true, language: true, isAutoGenerated: true, fetchedAt: true, _count: { select: { chunks: true } } } },
    },
  });
  if (!v) throw notFound("Video");
  return {
    ...v,
    nodeId: `video:${v.youtubeId}`,
    url: `https://www.youtube.com/watch?v=${v.youtubeId}`,
    publishedAt: v.publishedAt.toISOString(),
    viewCount: num(v.viewCount),
    likeCount: num(v.likeCount),
    commentCount: num(v.commentCount),
    channel: { ...v.channel, nodeId: `channel:${v.channel.youtubeId}`, subscriberCount: num(v.channel.subscriberCount) },
    topics: v.topics.map((t) => ({ ...t.topic, nodeId: `topic:${t.topic.slug}`, weight: t.weight, source: t.source, materialized: t.topic.videoCount >= 2 })),
    transcript: v.transcript && { source: v.transcript.source, language: v.transcript.language, isAutoGenerated: v.transcript.isAutoGenerated, fetchedAt: v.transcript.fetchedAt.toISOString(), chunks: v.transcript._count.chunks },
  };
}

export async function nicheTree() {
  const rows = await db.niche.findMany({ orderBy: [{ depth: "asc" }, { name: "asc" }], select: { id: true, slug: true, name: true, description: true, depth: true, parentId: true, channelCount: true, discoveryQueries: true } });
  const roots = rows.filter((r) => r.depth === 0).map((r) => ({ ...r, nodeId: `niche:${r.slug}`, children: [] as (typeof rows[number] & { nodeId: string })[] }));
  const byId = new Map(roots.map((r) => [r.id, r]));
  for (const r of rows.filter((x) => x.depth === 1)) byId.get(r.parentId!)?.children.push({ ...r, nodeId: `subniche:${r.slug}` });
  return roots;
}

export async function nicheDetail(idOrSlug: string) {
  const n = await db.niche.findFirst({ where: { OR: [{ id: idOrSlug }, { slug: idOrSlug.replace(/^(sub)?niche:/, "") }] }, select: { id: true, slug: true, name: true, description: true, depth: true, keywords: true, discoveryQueries: true, channelCount: true, parent: { select: { slug: true, name: true } }, children: { select: { id: true, slug: true, name: true, channelCount: true } } } });
  if (!n) throw notFound("Niche");
  const nicheIds = n.depth === 0 ? n.children.map((c) => c.id) : [n.id];
  const channels = await db.channel.findMany({ where: { niches: { some: { nicheId: { in: nicheIds } } } }, orderBy: { subscriberCount: { sort: "desc", nulls: "last" } }, take: 25, select: channelSummarySelect });
  const topics = await db.$queryRaw<{ slug: string; label: string; w: number }[]>`
    SELECT t.slug, t.label, sum(vt.weight * cn.confidence)::float AS w FROM "ChannelNiche" cn
    JOIN "Video" v ON v."channelId" = cn."channelId" JOIN "VideoTopic" vt ON vt."videoId" = v.id JOIN "Topic" t ON t.id = vt."topicId"
    WHERE cn."nicheId" = ANY(${nicheIds}) AND t."videoCount" >= 2 GROUP BY t.slug, t.label ORDER BY w DESC LIMIT 15`;
  return { ...n, nodeId: `${n.depth === 0 ? "niche" : "subniche"}:${n.slug}`, channels: channels.map(toSummary), topics: topics.map((t) => ({ ...t, nodeId: `topic:${t.slug}`, w: +t.w.toFixed(3) })) };
}

export async function topicDetail(idOrSlug: string) {
  const t = await db.topic.findFirst({ where: { OR: [{ id: idOrSlug }, { slug: idOrSlug.replace(/^topic:/, "") }] }, select: { id: true, slug: true, label: true, aliases: true, videoCount: true, channelCount: true } });
  if (!t) throw notFound("Topic");
  const videos = await db.videoTopic.findMany({ where: { topicId: t.id }, orderBy: { weight: "desc" }, take: 30, select: { weight: true, video: { select: { id: true, youtubeId: true, title: true, thumbnailUrl: true, publishedAt: true, viewCount: true, channel: { select: { title: true, youtubeId: true } } } } } });
  const channels = await db.$queryRaw<{ id: string; youtubeId: string; title: string; thumbnailUrl: string | null; n: number }[]>`
    SELECT c.id, c."youtubeId", c.title, c."thumbnailUrl", count(*)::int AS n FROM "VideoTopic" vt JOIN "Video" v ON v.id = vt."videoId" JOIN "Channel" c ON c.id = v."channelId"
    WHERE vt."topicId" = ${t.id} GROUP BY c.id ORDER BY n DESC LIMIT 20`;
  return {
    ...t,
    nodeId: `topic:${t.slug}`,
    videos: videos.map((x) => ({ ...x.video, nodeId: `video:${x.video.youtubeId}`, weight: x.weight, viewCount: num(x.video.viewCount), publishedAt: x.video.publishedAt.toISOString(), channelNodeId: `channel:${x.video.channel.youtubeId}` })),
    channels: channels.map((c) => ({ ...c, nodeId: `channel:${c.youtubeId}`, videos: c.n })),
  };
}
