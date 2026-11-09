import { withRoute } from "@/server/http/withRoute";
import { IdParam } from "@/shared/contracts/common";
import { WorkspacePatch } from "@/shared/contracts/workspaces";
import { getWorkspace, updateWorkspace, deleteWorkspace } from "@/server/services/workspaces";

export const GET = withRoute({ auth: "required", params: IdParam }, async ({ user, params }) => getWorkspace(user.id, params.id));
export const PATCH = withRoute({ auth: "required", params: IdParam, body: WorkspacePatch }, async ({ user, params, body }) => updateWorkspace(user.id, params.id, body));
export const DELETE = withRoute({ auth: "required", params: IdParam }, async ({ user, params }) => {
  await deleteWorkspace(user.id, params.id);
  return { deleted: true };
});
