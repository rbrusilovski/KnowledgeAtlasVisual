import { z } from "zod";
import { withRoute } from "@/server/http/withRoute";
import { ExpansionScope } from "@/shared/contracts/expansion";
import { estimate, normalizeScope, scopeHash } from "@/server/services/expansion";

/** Read-only: what a scope would cost and collect (no proposal created, no quota spent). */
export const POST = withRoute({ auth: "required", body: z.object({ scope: ExpansionScope }) }, async ({ body }) => {
  const scope = normalizeScope(body.scope);
  return { scope, scopeHash: scopeHash(scope), estimate: estimate(scope), isEstimate: true };
});
