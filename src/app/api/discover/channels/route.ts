import { withRoute } from "@/server/http/withRoute";
import { env } from "@/server/env";
import { DiscoverBody } from "@/shared/contracts/discover";
import { discoverChannels } from "@/server/services/catalog";

export const POST = withRoute(
  { auth: "required", body: DiscoverBody, rateLimit: { name: "discovery", limit: env.RATE_LIMIT_DISCOVERY_PER_MIN, windowSec: 60 } },
  async ({ body, user }) => discoverChannels(body, user.id),
);
