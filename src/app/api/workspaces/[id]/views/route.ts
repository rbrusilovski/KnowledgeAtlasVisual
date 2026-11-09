import { withRoute, withMeta } from "@/server/http/withRoute";
import { IdParam } from "@/shared/contracts/common";
import { ViewBody } from "@/shared/contracts/workspaces";
import { listViews, createView } from "@/server/services/workspaces";

export const GET = withRoute({ auth: "required", params: IdParam }, async ({ user, params }) => listViews(user.id, params.id));
export const POST = withRoute({ auth: "required", params: IdParam, body: ViewBody }, async ({ user, params, body }) => withMeta(await createView(user.id, params.id, body), {}, 201));
