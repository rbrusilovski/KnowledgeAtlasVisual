import { withRoute, withMeta } from "@/server/http/withRoute";
import { CreateProposalBody, ProposalListQuery } from "@/shared/contracts/expansion";
import { createProposal, listProposals, toDTO, userActor } from "@/server/services/expansion";

export const dynamic = "force-dynamic";

/** Your proposals (admins: all, including SYSTEM proposals). */
export const GET = withRoute({ auth: "required", query: ProposalListQuery }, async ({ query, user }) => listProposals(userActor(user), query));

/** Create a pending proposal from an explicit scope. Server computes estimates; nothing runs until approved. */
export const POST = withRoute({ auth: "required", body: CreateProposalBody, rateLimit: { name: "proposal-create", limit: 60, windowSec: 3600 } }, async ({ body, user }) => {
  const actor = userActor(user);
  const p = await createProposal(body, actor);
  return withMeta(toDTO(p, actor), {}, 201);
});
