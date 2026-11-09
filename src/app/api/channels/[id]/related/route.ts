import { z } from "zod";
import { withRoute } from "@/server/http/withRoute";
import { db } from "@/server/db";
import { IdParam } from "@/shared/contracts/common";
import { findChannelId } from "@/server/services/catalog";
import { relatedCreators } from "@/server/services/graph";

export const GET = withRoute({ auth: "none", params: IdParam, query: z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }) }, async ({ params, query }) => {
  const id = await findChannelId(params.id);
  const c = await db.channel.findUniqueOrThrow({ where: { id }, select: { youtubeId: true } });
  return relatedCreators(c.youtubeId, query.limit);
});
