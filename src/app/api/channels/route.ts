import { withRoute, withMeta } from "@/server/http/withRoute";
import { env } from "@/server/env";
import { AddChannelBody, ChannelListQuery } from "@/shared/contracts/channels";
import { addChannel, listChannels } from "@/server/services/catalog";
import { userActor } from "@/server/services/expansion";

export const dynamic = "force-dynamic";

/** Resolves the input and creates a PENDING proposal. Collection starts only after POST /api/expansions/:id/approve. */
export const POST = withRoute(
  {
    auth: "required",
    body: AddChannelBody,
    rateLimit: { name: "channel-add", limit: env.RATE_LIMIT_CHANNEL_ADDS_PER_HOUR, windowSec: 3600 },
  },
  async ({ body, user }) => {
    const r = await addChannel(body.input, { confirm: body.confirm, actor: userActor(user) });
    return withMeta(r, {}, r.status === "proposed" ? 201 : 200);
  },
);

export const GET = withRoute({ auth: "none", query: ChannelListQuery }, async ({ query }) => {
  const { items, nextCursor } = await listChannels(query);
  return withMeta(items, { nextCursor });
});
