import { withRoute } from "@/server/http/withRoute";
import { IdParam } from "@/shared/contracts/common";
import { membership } from "@/server/services/workspaces";

/** nodeId → collectionIds, for the "collection membership" graph filter. */
export const GET = withRoute({ auth: "required", params: IdParam }, async ({ user, params }) => membership(user.id, params.id));
