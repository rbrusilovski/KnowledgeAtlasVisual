import { withRoute } from "@/server/http/withRoute";
import { IdParam } from "@/shared/contracts/common";
import { channelDetail, findChannelId } from "@/server/services/catalog";
import { markViewed } from "@/server/services/ingestion";

export const GET = withRoute({ auth: "optional", params: IdParam }, async ({ params, user }) => {
  const id = await findChannelId(params.id);
  if (user) await markViewed(id); // viewed in the last 7 days → HOT sync tier
  return channelDetail(id);
});
