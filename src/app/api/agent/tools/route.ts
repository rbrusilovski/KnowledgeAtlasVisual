import { withRoute } from "@/server/http/withRoute";
import { enforceRateLimit } from "@/server/http/rateLimit";
import { authenticateAgent, describeTools } from "@/server/services/agent";

export const dynamic = "force-dynamic";

/** Tool catalogue for agent clients (MCP adapter). Bearer agent token only; browser sessions are not consulted. */
export const GET = withRoute({ auth: "none", rateLimit: false }, async ({ req }) => {
  const agent = await authenticateAgent(req.headers);
  await enforceRateLimit({ name: "agent", limit: 120, windowSec: 60 }, `agent:${agent.tokenId}`);
  return { tools: describeTools().filter((t) => agent.scopes.includes(t.access)), scopes: agent.scopes };
});
