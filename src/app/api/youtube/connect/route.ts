import { withRoute } from "@/server/http/withRoute";
import { authorizationUrl } from "@/server/youtube/oauth";

export const GET = withRoute({ auth: "required" }, async ({ user }) => Response.redirect(await authorizationUrl(user.id), 302));
