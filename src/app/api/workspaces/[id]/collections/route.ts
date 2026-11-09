import { withRoute, withMeta } from "@/server/http/withRoute";
import { IdParam } from "@/shared/contracts/common";
import { CollectionBody } from "@/shared/contracts/workspaces";
import { listCollections, createCollection } from "@/server/services/workspaces";

export const GET = withRoute({ auth: "required", params: IdParam }, async ({ user, params }) => listCollections(user.id, params.id));
export const POST = withRoute({ auth: "required", params: IdParam, body: CollectionBody }, async ({ user, params, body }) => withMeta(await createCollection(user.id, params.id, body), {}, 201));
