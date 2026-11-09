import { withRoute } from "@/server/http/withRoute";
import { IdParam } from "@/shared/contracts/common";
import { AddItemsBody, RemoveItemsBody } from "@/shared/contracts/workspaces";
import { addItems, removeItems } from "@/server/services/workspaces";

export const POST = withRoute({ auth: "required", params: IdParam, body: AddItemsBody }, async ({ user, params, body }) => addItems(user.id, params.id, body.items));
export const DELETE = withRoute({ auth: "required", params: IdParam, body: RemoveItemsBody }, async ({ user, params, body }) => removeItems(user.id, params.id, body));
