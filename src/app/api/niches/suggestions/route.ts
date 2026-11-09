import { z } from "zod";
import { withRoute, withMeta } from "@/server/http/withRoute";
import { suggestSubniches, acceptSubnicheSuggestion } from "@/server/services/classification";

export const dynamic = "force-dynamic";

/** Suggested subniches from clusters of low-confidence channels (admin: accepting changes the shared taxonomy). */
export const GET = withRoute({ auth: "admin" }, async () => suggestSubniches());

export const POST = withRoute(
  {
    auth: "admin",
    body: z.object({
      channelIds: z.array(z.string().min(1).max(100)).min(2).max(200),
      name: z.string().trim().min(2).max(60),
      parentSlug: z.string().min(1).max(80),
      description: z.string().trim().max(500).optional(),
      keywords: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
    }),
  },
  async ({ body }) => withMeta(await acceptSubnicheSuggestion(body), {}, 201),
);
