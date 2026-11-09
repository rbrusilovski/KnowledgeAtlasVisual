import { withRoute } from "@/server/http/withRoute";
import { IdParam } from "@/shared/contracts/common";
import { LayoutBody } from "@/shared/contracts/workspaces";
import { getLayout, putLayout } from "@/server/services/workspaces";

export const GET = withRoute({ auth: "required", params: IdParam }, async ({ user, params }) => getLayout(user.id, params.id));
export const PUT = withRoute({ auth: "required", params: IdParam, body: LayoutBody }, async ({ user, params, body }) => putLayout(user.id, params.id, body.positions, body.remove));
