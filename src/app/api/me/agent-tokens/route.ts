import { withRoute, withMeta } from "@/server/http/withRoute";
import { CreateAgentTokenBody } from "@/shared/contracts/agent";
import { createAgentToken, listAgentTokens } from "@/server/services/agent";

export const dynamic = "force-dynamic";

/** Your agent tokens (metadata only — the secret is never shown again). Session-authenticated. */
export const GET = withRoute({ auth: "required" }, async ({ user }) => listAgentTokens(user.id));

/** Create an agent token. The plaintext token is returned once in this response. */
export const POST = withRoute({ auth: "required", body: CreateAgentTokenBody, rateLimit: { name: "agent-token-create", limit: 20, windowSec: 3600 } }, async ({ body, user }) => {
  const r = await createAgentToken(user.id, body);
  return withMeta(r, { shownOnce: true }, 201);
});
