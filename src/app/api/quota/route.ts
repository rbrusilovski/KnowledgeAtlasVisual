import { withRoute } from "@/server/http/withRoute";
import { usage, userDiscoveryUsage } from "@/server/services/quota";
import { env } from "@/server/env";

export const dynamic = "force-dynamic";

export const GET = withRoute({ auth: "optional" }, async ({ user }) => {
  const u = await usage();
  return {
    ...u,
    model: env.QUOTA_SEARCH_MODEL,
    mode: env.YOUTUBE_MODE,
    backgroundRatio: env.QUOTA_BACKGROUND_RATIO,
    user: user ? await userDiscoveryUsage(user.id) : null,
  };
});
