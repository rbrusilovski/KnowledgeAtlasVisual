import { z } from "zod";

/**
 * Agent (Claude) access. An agent token lets a tool client act for one user: inspect Atlas ("read"), estimate and
 * create pending expansion proposals ("propose"), optionally see that user's private transcripts in search
 * ("private-transcripts"). There is no scope that approves — approval is a signed-in human action in Atlas.
 */
export const AGENT_SCOPES = ["read", "propose", "private-transcripts"] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

export const CreateAgentTokenBody = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(AGENT_SCOPES)).max(AGENT_SCOPES.length).default(["read", "propose"]),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

export interface AgentTokenDTO {
  id: string;
  name: string;
  prefix: string;
  scopes: AgentScope[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  active: boolean;
}

export interface AgentToolDescriptor {
  name: string;
  description: string;
  /** "read" tools run in a read-only database scope; "propose" tools may only create PENDING proposals. */
  access: "read" | "propose";
  inputSchema: Record<string, unknown>;
}

export const ToolNameParam = z.object({ name: z.string().regex(/^atlas_[a-z_]{2,48}$/) });
