import { withRoute } from "@/server/http/withRoute";
import { enforceRateLimit } from "@/server/http/rateLimit";
import { AppError } from "@/server/errors";
import { ReadOnlyViolation } from "@/server/db";
import { log } from "@/server/logger";
import { ToolNameParam } from "@/shared/contracts/agent";
import { authenticateAgent, runTool, toolByName } from "@/server/services/agent";

export const dynamic = "force-dynamic";

/**
 * Invoke one Atlas tool as an agent. Authenticated ONLY by `Authorization: Bearer atl_…` (session cookies are never
 * read here, so a browser page cannot drive it with the user's session). Input is untrusted and validated per tool.
 * There is deliberately no tool — and no agent route — that approves, rejects or cancels a proposal.
 */
export const POST = withRoute({ auth: "none", rateLimit: false, params: ToolNameParam }, async ({ req, params }) => {
  const agent = await authenticateAgent(req.headers);
  await enforceRateLimit({ name: "agent", limit: 120, windowSec: 60 }, `agent:${agent.tokenId}`);
  const t = toolByName(params.name);
  if (t?.access === "propose") await enforceRateLimit({ name: "agent-propose", limit: 30, windowSec: 3600 }, `agent:${agent.tokenId}`);
  let input: unknown = {};
  const text = await req.text();
  if (text) {
    try {
      input = JSON.parse(text);
    } catch {
      throw new AppError("VALIDATION_ERROR", "Malformed JSON body");
    }
  }
  const t0 = performance.now();
  try {
    const result = await runTool(params.name, (input as { input?: unknown })?.input ?? input, { userId: agent.userId, scopes: agent.scopes, tokenId: agent.tokenId });
    log().info({ tool: params.name, tokenId: agent.tokenId, userId: agent.userId, ms: Math.round(performance.now() - t0) }, "agent tool call");
    return result;
  } catch (err) {
    log().warn({ tool: params.name, tokenId: agent.tokenId, userId: agent.userId, err: err instanceof Error ? err.message : String(err) }, "agent tool call failed");
    if (err instanceof ReadOnlyViolation) throw new AppError("FORBIDDEN", "A read-only tool attempted to modify Atlas; the call was blocked");
    throw err;
  }
});
