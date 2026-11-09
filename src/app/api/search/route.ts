import { withRoute, withMeta } from "@/server/http/withRoute";
import { SearchQuery, SEARCH_TYPES } from "@/shared/contracts/search";
import { search } from "@/server/services/search";
import { findChannelId } from "@/server/services/catalog";
import { unauthorized } from "@/server/errors";

export const dynamic = "force-dynamic";

export const GET = withRoute({ auth: "optional", query: SearchQuery }, async ({ query, user }) => {
  const t0 = performance.now();
  const channelId = query.channelId ? await findChannelId(query.channelId) : undefined;
  const mine = query.transcripts === "mine";
  if (mine && !user) throw unauthorized();
  const requested = mine ? (["transcript"] as const) : query.types?.length ? query.types : channelId ? (["video", "transcript"] as const) : SEARCH_TYPES;
  // Transcript text requires sign-in (same rule as GET /api/videos/:id/transcript), so anonymous searches skip it.
  const types = user ? [...requested] : requested.filter((t) => t !== "transcript");
  if (!types.length) return withMeta([], { nextCursor: null, mode: query.mode, effectiveMode: query.mode, counts: {}, ms: Math.round(performance.now() - t0), signInRequired: true });
  const r = await search({ q: query.q, mode: query.mode, types, limit: query.limit, cursor: query.cursor, filter: { channelId, viewer: { userId: user?.id ?? null, onlyOwn: mine } } });
  return withMeta(r.items, { nextCursor: r.nextCursor, mode: r.mode, effectiveMode: r.effectiveMode, counts: r.counts, ms: Math.round(performance.now() - t0) });
});
