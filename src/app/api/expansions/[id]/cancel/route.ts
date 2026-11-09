import { withRoute } from "@/server/http/withRoute";
import { IdParam } from "@/shared/contracts/common";
import { cancelProposal, toDTO, userActor } from "@/server/services/expansion";

/** Stop a pending or running proposal; running jobs stop at their next page/batch boundary. */
export const POST = withRoute({ auth: "required", params: IdParam }, async ({ params, user }) => {
  const actor = userActor(user);
  return toDTO(await cancelProposal(params.id, actor), actor);
});
