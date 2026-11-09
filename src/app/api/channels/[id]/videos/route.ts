import { withRoute, withMeta } from "@/server/http/withRoute";
import { IdParam } from "@/shared/contracts/common";
import { ChannelVideosQuery } from "@/shared/contracts/channels";
import { channelVideos } from "@/server/services/search";
import { findChannelId } from "@/server/services/catalog";

export const GET = withRoute({ auth: "none", params: IdParam, query: ChannelVideosQuery }, async ({ params, query }) => {
  const id = await findChannelId(params.id);
  const r = await channelVideos(id, query);
  return withMeta(r.items, { nextCursor: r.nextCursor, facets: r.facets, effectiveMode: r.effectiveMode });
});
