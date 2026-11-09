import { z } from "zod";
import { withRoute } from "@/server/http/withRoute";
import { ItemPatch } from "@/shared/contracts/workspaces";
import { updateItem } from "@/server/services/workspaces";

export const PATCH = withRoute({ auth: "required", params: z.object({ id: z.string().max(100), itemId: z.string().max(100) }), body: ItemPatch }, async ({ user, params, body }) => updateItem(user.id, params.id, params.itemId, body));
