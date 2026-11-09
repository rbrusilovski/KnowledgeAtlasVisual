import { z } from "zod";
import type { AgentToolDescriptor } from "@/shared/contracts/agent";
import { TOOLS } from "./tools";

export { authenticateAgent, createAgentToken, listAgentTokens, revokeAgentToken, hashToken, generateToken, TOKEN_PREFIX, type AgentPrincipal } from "./tokens";
export { runTool, toolByName, TOOLS, type ToolContext, type AgentTool } from "./tools";

/** Tool catalogue with JSON Schemas (consumed by the MCP adapter). */
export function describeTools(): AgentToolDescriptor[] {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, access: t.access, inputSchema: z.toJSONSchema(t.input, { io: "input", unrepresentable: "any" }) as Record<string, unknown> }));
}
