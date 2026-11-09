import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "@/server/db";
import { AppError, notFound } from "@/server/errors";
import { AGENT_SCOPES, type AgentScope, type AgentTokenDTO } from "@/shared/contracts/agent";

export const TOKEN_PREFIX = "atl_";
const MAX_ACTIVE_TOKENS_PER_USER = 10;
const TOUCH_EVERY_MS = 60_000;

/** The authenticated agent: acts for `userId`, limited to `scopes`. Never an approving actor. */
export interface AgentPrincipal {
  tokenId: string;
  userId: string;
  scopes: AgentScope[];
}

export const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

export function generateToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

function toDTO(t: { id: string; name: string; prefix: string; scopes: string[]; createdAt: Date; lastUsedAt: Date | null; expiresAt: Date | null; revokedAt: Date | null }): AgentTokenDTO {
  return {
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    scopes: t.scopes as AgentScope[],
    createdAt: t.createdAt.toISOString(),
    lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
    expiresAt: t.expiresAt?.toISOString() ?? null,
    revokedAt: t.revokedAt?.toISOString() ?? null,
    active: !t.revokedAt && (!t.expiresAt || t.expiresAt.getTime() > Date.now()),
  };
}

/** Creates a token. The plaintext is returned exactly once; only its SHA-256 hash is stored. */
export async function createAgentToken(userId: string, input: { name: string; scopes: AgentScope[]; expiresInDays?: number }) {
  const active = await db.agentToken.count({ where: { userId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } });
  if (active >= MAX_ACTIVE_TOKENS_PER_USER) throw new AppError("CONFLICT", `At most ${MAX_ACTIVE_TOKENS_PER_USER} active agent tokens; revoke one first`);
  const scopes = [...new Set(input.scopes)].filter((s): s is AgentScope => (AGENT_SCOPES as readonly string[]).includes(s));
  if (!scopes.includes("read")) scopes.unshift("read");
  const token = generateToken();
  const row = await db.agentToken.create({
    data: {
      userId,
      name: input.name,
      tokenHash: hashToken(token),
      prefix: token.slice(0, TOKEN_PREFIX.length + 6),
      scopes,
      expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null,
    },
  });
  return { token, record: toDTO(row) };
}

export async function listAgentTokens(userId: string): Promise<AgentTokenDTO[]> {
  const rows = await db.agentToken.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  return rows.map(toDTO);
}

export async function revokeAgentToken(userId: string, id: string) {
  const r = await db.agentToken.updateMany({ where: { id, userId, revokedAt: null }, data: { revokedAt: new Date() } });
  if (!r.count) {
    const exists = await db.agentToken.findFirst({ where: { id, userId }, select: { id: true } });
    if (!exists) throw notFound("Agent token"); // never reveal other users' tokens
  }
  return { revoked: true };
}

const unauthorizedAgent = (why: string) => new AppError("UNAUTHORIZED", `Agent token ${why}`, undefined, { "www-authenticate": 'Bearer realm="atlas-agent"' });

/** `Authorization: Bearer atl_…` → principal. Rejects missing, malformed, unknown, revoked and expired tokens. */
export async function authenticateAgent(headers: Headers): Promise<AgentPrincipal> {
  const h = headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  if (!m) throw unauthorizedAgent("required (Authorization: Bearer atl_…)");
  const token = m[1]!;
  if (!token.startsWith(TOKEN_PREFIX) || token.length < TOKEN_PREFIX.length + 40 || token.length > 120) throw unauthorizedAgent("is malformed");
  const hash = hashToken(token);
  const row = await db.agentToken.findUnique({ where: { tokenHash: hash }, select: { id: true, userId: true, scopes: true, revokedAt: true, expiresAt: true, lastUsedAt: true, tokenHash: true } });
  // Constant-time comparison of the stored hash (defence in depth; the lookup is already by hash).
  if (!row || !timingSafeEqual(Buffer.from(row.tokenHash, "hex"), Buffer.from(hash, "hex"))) throw unauthorizedAgent("is invalid");
  if (row.revokedAt) throw unauthorizedAgent("has been revoked");
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) throw unauthorizedAgent("has expired");
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > TOUCH_EVERY_MS) {
    await db.agentToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  }
  return { tokenId: row.id, userId: row.userId, scopes: row.scopes as AgentScope[] };
}
