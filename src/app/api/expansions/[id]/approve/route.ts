import { withRoute } from "@/server/http/withRoute";
import { IdParam } from "@/shared/contracts/common";
import { DecideProposalBody } from "@/shared/contracts/expansion";
import { approveProposal, toDTO, userActor } from "@/server/services/expansion";

/**
 * Explicit, single-use decision by the signed-in user (session cookie — never an agent). The body must echo the
 * scopeHash that was reviewed; a changed scope cannot be approved with an old hash.
 */
export const POST = withRoute({ auth: "required", params: IdParam, body: DecideProposalBody, rateLimit: { name: "proposal-decide", limit: 120, windowSec: 3600 } }, async ({ params, body, user }) => {
  const actor = userActor(user);
  return toDTO(await approveProposal(params.id, actor, body.scopeHash, body.note), actor);
});
