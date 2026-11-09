import { z } from "zod";
import { withRoute } from "@/server/http/withRoute";
import { env } from "@/server/env";
import { handleCallback } from "@/server/youtube/oauth";

export const GET = withRoute({ auth: "required", query: z.object({ code: z.string().max(2000).optional(), state: z.string().max(200), error: z.string().max(200).optional() }) }, async ({ user, query }) => {
  const back = new URL("/settings", env.BETTER_AUTH_URL);
  if (query.error || !query.code) {
    back.searchParams.set("youtube", "denied");
    return Response.redirect(back, 302);
  }
  const r = await handleCallback(user.id, query.code, query.state);
  back.searchParams.set("youtube", `connected:${r.channelIds.length}`);
  return Response.redirect(back, 302);
});
