import { withRoute } from "@/server/http/withRoute";
import { IdParam } from "@/shared/contracts/common";
import { ViewPatch } from "@/shared/contracts/workspaces";
import { updateView, deleteView } from "@/server/services/workspaces";

export const PATCH = withRoute({ auth: "required", params: IdParam, body: ViewPatch }, async ({ user, params, body }) => updateView(user.id, params.id, body));
export const DELETE = withRoute({ auth: "required", params: IdParam }, async ({ user, params }) => {
  await deleteView(user.id, params.id);
  return { deleted: true };
});
