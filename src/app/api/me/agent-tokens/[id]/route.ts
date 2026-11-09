import { withRoute } from "@/server/http/withRoute";
import { IdParam } from "@/shared/contracts/common";
import { revokeAgentToken } from "@/server/services/agent";

/** Revoke one of your agent tokens (takes effect on the next call). */
export const DELETE = withRoute({ auth: "required", params: IdParam }, async ({ params, user }) => revokeAgentToken(user.id, params.id));
