import { withRoute } from "@/server/http/withRoute";
import { IdParam } from "@/shared/contracts/common";
import { getProposal, userActor } from "@/server/services/expansion";

export const GET = withRoute({ auth: "required", params: IdParam }, async ({ params, user }) => getProposal(params.id, userActor(user)));
