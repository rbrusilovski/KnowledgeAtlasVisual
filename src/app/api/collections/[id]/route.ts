import { withRoute } from "@/server/http/withRoute";
import { IdParam } from "@/shared/contracts/common";
import { CollectionPatch } from "@/shared/contracts/workspaces";
import { getCollection, updateCollection, deleteCollection } from "@/server/services/workspaces";

export const GET = withRoute({ auth: "required", params: IdParam }, async ({ user, params }) => getCollection(user.id, params.id));
export const PATCH = withRoute({ auth: "required", params: IdParam, body: CollectionPatch }, async ({ user, params, body }) => updateCollection(user.id, params.id, body));
export const DELETE = withRoute({ auth: "required", params: IdParam }, async ({ user, params }) => {
  await deleteCollection(user.id, params.id);
  return { deleted: true };
});
