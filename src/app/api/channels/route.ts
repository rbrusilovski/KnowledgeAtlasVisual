import { withRoute, withMeta } from "@/server/http/withRoute";
import { env } from "@/server/env";
import { AddChannelBody, ChannelListQuery } from "@/shared/contracts/channels";
import { addChannel, listChannels } from "@/server/services/catalog";

export const dynamic = "force-dynamic";

export const POST = withRoute(
  {
    auth: "required",
    body: AddChannelBody,
    rateLimit: { name: "channel-add", limit: env.RATE_LIMIT_CHANNEL_ADDS_PER_HOUR, windowSec: 3600 },
  },
  async ({ body, user }) => {
    const r = await addChannel(body.input, { confirm: body.confirm, userId: user.id });
    return withMeta(r, {}, r.status === "queued" ? 202 : 200);
  },
);

export const GET = withRoute({ auth: "none", query: ChannelListQuery }, async ({ query }) => {
  const { items, nextCursor } = await listChannels(query);
  return withMeta(items, { nextCursor });
});
