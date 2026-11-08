import { db, type Prisma } from "@/server/db";
import { AppError, notFound } from "@/server/errors";
import { enqueue } from "@/server/jobs";
import { decodeCursor, encodeCursor } from "@/server/http/cursor";
import { resolveChannelInput } from "@/server/youtube/resolve";
import type { AddChannelResult } from "@/shared/contracts/jobs";
import type { ChannelSummary } from "@/shared/contracts/channels";
import type { z } from "zod";
import type { ChannelListQuery } from "@/shared/contracts/channels";

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
