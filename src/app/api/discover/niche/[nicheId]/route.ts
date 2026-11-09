import { z } from "zod";
import { withRoute } from "@/server/http/withRoute";
import { env } from "@/server/env";
import { DiscoverNicheBody } from "@/shared/contracts/discover";
import { discoverNiche } from "@/server/services/catalog";

export const POST = withRoute(
  { auth: "required", params: z.object({ nicheId: z.string().max(100) }), body: DiscoverNicheBody, rateLimit: { name: "discovery", limit: env.RATE_LIMIT_DISCOVERY_PER_MIN, windowSec: 60 } },
  async ({ params, body, user }) => discoverNiche(params.nicheId, body, user.id),
);
