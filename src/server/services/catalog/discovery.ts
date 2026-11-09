import { db } from "@/server/db";
import { AppError, notFound } from "@/server/errors";
import { enqueue } from "@/server/jobs";
import { youtube, withYouTubeContext, costOf, bestThumb, policyAllows } from "@/server/youtube";
import { reserveUserDiscovery, refundUserDiscovery, usage } from "@/server/services/quota";
import { embedTexts } from "@/server/services/embeddings";
import { toVectorLiteral } from "@/server/db/vector";

export interface DiscoveredChannel {
  youtubeId: string;
  title: string;
  description: string;
  handle: string | null;
  thumbnailUrl: string | null;
  subscriberCount: number | null;
  videoCount: number | null;
  viewCount: number | null;
  country: string | null;
  inAtlas: boolean;
  atlasChannelId: string | null;
  nicheGuess: { slug: string; name: string; similarity: number } | null;
  url: string;
}

export interface DiscoveryResult {
  query: string;
  results: DiscoveredChannel[];
  quotaUsed: { general: number; search: number };
  cached: boolean;
  quota: Awaited<ReturnType<typeof usage>>["buckets"];
}

async function guessNiches(texts: string[]) {
  if (!texts.length) return [];
  const vecs = await embedTexts(texts);
  return Promise.all(
    vecs.map(async (v) => {
      const rows = await db.$queryRaw<{ slug: string; name: string; sim: number }[]>`
        SELECT slug, name, 1 - (centroid <=> ${toVectorLiteral(v)}::vector) AS sim FROM "Niche"
        WHERE centroid IS NOT NULL AND depth = 1 ORDER BY centroid <=> ${toVectorLiteral(v)}::vector LIMIT 1`;
      return rows[0] ? { slug: rows[0].slug, name: rows[0].name, similarity: +rows[0].sim.toFixed(3) } : null;
    }),
  );
}

/** One or more search.list calls → channels.list enrichment (1 unit / 50) → niche guess (local) → in-atlas flags. */
async function runSearches(queries: string[], opts: { userId: string; nicheId?: string; regionCode?: string; relevanceLanguage?: string; maxResults: number }): Promise<DiscoveryResult> {
  const spent = { general: 0, search: 0 };
  await reserveUserDiscovery(opts.userId, queries.length);
  let hits: { channelId: string; title: string; description: string; thumbnailUrl?: string }[] = [];
  try {
    await withYouTubeContext({ lane: "interactive", onCost: (_m, bucket, units) => (bucket === "search" ? (spent.search += units) : (spent.general += units)) }, async () => {
      for (const q of queries) hits.push(...(await youtube.searchChannels({ q, regionCode: opts.regionCode, relevanceLanguage: opts.relevanceLanguage, maxResults: opts.maxResults })));
    });
  } catch (e) {
    await refundUserDiscovery(opts.userId, queries.length);
    throw e;
  }
  const searchesUsed = spent.search > 0 ? queries.length : 0;
  // Cached searches cost nothing: don't count them against the user's daily cap.
  if (queries.length - searchesUsed > 0 && spent.search === 0) await refundUserDiscovery(opts.userId, queries.length);
  const seen = new Set<string>();
  hits = hits.filter((h) => !seen.has(h.channelId) && seen.add(h.channelId));

  const details = await withYouTubeContext({ lane: "interactive", onCost: (_m, _b, u) => (spent.general += u) }, () => youtube.getChannels({ ids: hits.map((h) => h.channelId) }));
  const byId = new Map(details.map((d) => [d.id, d]));
  const inAtlas = new Map((await db.channel.findMany({ where: { youtubeId: { in: hits.map((h) => h.channelId) } }, select: { id: true, youtubeId: true } })).map((c) => [c.youtubeId, c.id]));
  const guesses = await guessNiches(hits.map((h) => `${h.title}\n${byId.get(h.channelId)?.snippet?.description ?? h.description}\n${byId.get(h.channelId)?.brandingSettings?.channel?.keywords ?? ""}`));

  const results: DiscoveredChannel[] = hits.map((h, i) => {
    const d = byId.get(h.channelId);
    const custom = d?.snippet?.customUrl;
    return {
      youtubeId: h.channelId,
      title: d?.snippet?.title ?? h.title,
      description: (d?.snippet?.description ?? h.description).slice(0, 400),
      handle: custom?.startsWith("@") ? custom.slice(1) : null,
      thumbnailUrl: bestThumb(d?.snippet?.thumbnails) ?? h.thumbnailUrl ?? null,
      subscriberCount: d?.statistics?.hiddenSubscriberCount ? null : d?.statistics?.subscriberCount !== undefined ? Number(d.statistics.subscriberCount) : null,
      videoCount: d?.statistics?.videoCount !== undefined ? Number(d.statistics.videoCount) : null,
      viewCount: d?.statistics?.viewCount !== undefined ? Number(d.statistics.viewCount) : null,
      country: d?.snippet?.country ?? null,
      inAtlas: inAtlas.has(h.channelId),
      atlasChannelId: inAtlas.get(h.channelId) ?? null,
      nicheGuess: guesses[i] ?? null,
      url: `https://www.youtube.com/channel/${h.channelId}`,
    };
  });

  await db.discoveryQuery.create({ data: { userId: opts.userId, query: queries.join(" | "), nicheId: opts.nicheId, resultChannelIds: results.map((r) => r.youtubeId) } });
  // CO_DISCOVERED edges for result channels already in the atlas.
  const present = results.filter((r) => r.inAtlas).map((r) => `channel:${r.youtubeId}`);
  // Cross-owner relation: policy-gated for live data. Discovery previews never add channels to the corpus.
  if (present.length > 1 && policyAllows("cross-owner-aggregation")) await enqueue.graph(present);
  return { query: queries.join(" | "), results, quotaUsed: spent, cached: spent.search === 0, quota: (await usage()).buckets };
}

export async function discoverChannels(p: { query: string; nicheId?: string; regionCode?: string; relevanceLanguage?: string; maxResults: number }, userId: string) {
  return runSearches([p.query], { userId, nicheId: p.nicheId, regionCode: p.regionCode, relevanceLanguage: p.relevanceLanguage, maxResults: p.maxResults });
}

/** Runs a subniche's discoveryQueries; needs explicit confirmation because it spends several searches. */
export async function discoverNiche(nicheIdOrSlug: string, p: { confirm?: boolean; maxResults: number; regionCode?: string }, userId: string) {
  const niche = await db.niche.findFirst({ where: { OR: [{ id: nicheIdOrSlug }, { slug: nicheIdOrSlug }] }, select: { id: true, name: true, discoveryQueries: true } });
  if (!niche) throw notFound("Niche");
  if (!niche.discoveryQueries.length) throw new AppError("VALIDATION_ERROR", "This niche has no discovery queries");
  const unit = costOf("search.list");
  if (!p.confirm) {
    throw new AppError("NEEDS_CONFIRMATION", `Discovering “${niche.name}” runs ${niche.discoveryQueries.length} YouTube searches.`, {
      needsConfirmation: { cost: { bucket: unit.bucket, units: unit.units * niche.discoveryQueries.length } },
      queries: niche.discoveryQueries,
    });
  }
  return runSearches(niche.discoveryQueries, { userId, nicheId: niche.id, regionCode: p.regionCode, maxResults: p.maxResults });
}
