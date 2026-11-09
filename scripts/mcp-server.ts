/**
 * pnpm mcp — local stdio MCP adapter that exposes Atlas's agent tools to Claude.
 *
 * It holds no database or service access of its own: every call is forwarded to the running Atlas server's
 * `/api/agent/tools/*` endpoint with an agent token, so server-side authorization, read-only enforcement, quota and
 * approval rules apply unchanged. Tool descriptions are informational only — they are not a security control.
 *
 * Env: ATLAS_URL (default http://localhost:3000), ATLAS_AGENT_TOKEN (create one in Atlas → Settings → Agent access).
 *
 * Claude Code / Claude Desktop config:
 *   { "mcpServers": { "atlas": { "command": "pnpm", "args": ["-s", "mcp"], "cwd": "<repo>",
 *       "env": { "ATLAS_URL": "http://localhost:3000", "ATLAS_AGENT_TOKEN": "atl_…" } } } }
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const BASE = (process.env.ATLAS_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const TOKEN = process.env.ATLAS_AGENT_TOKEN ?? "";
const MAX_TEXT = 200_000;

if (!TOKEN.startsWith("atl_")) {
  process.stderr.write("[atlas-mcp] ATLAS_AGENT_TOKEN is missing or malformed (create one in Atlas → Settings → Agent access)\n");
  process.exit(1);
}

interface Descriptor {
  name: string;
  description: string;
  access: "read" | "propose";
  inputSchema: Record<string, unknown>;
}

async function atlas<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await res.json().catch(() => ({}))) as { data?: T; error?: { code: string; message: string; details?: unknown } };
  if (!res.ok || body.error) {
    const e = body.error ?? { code: `HTTP_${res.status}`, message: res.statusText };
    throw Object.assign(new Error(`${e.code}: ${e.message}`), { details: e.details });
  }
  return body.data as T;
}

const server = new Server({ name: "atlas", version: "1.0.0" }, { capabilities: { tools: {} }, instructions: "Atlas knowledge-graph tools. Inspection tools are read-only. Proposal tools only create PENDING proposals — the user must approve each one in Atlas; you cannot approve proposals." });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const { tools } = await atlas<{ tools: Descriptor[] }>("/api/agent/tools");
  return {
    tools: tools.map((t) => ({
      name: t.name,
      description: `${t.description}${t.access === "propose" ? " (Creates a pending proposal; requires user approval in Atlas.)" : " (Read-only.)"}`,
      inputSchema: { type: "object", ...t.inputSchema } as { type: "object"; [k: string]: unknown },
      annotations: { readOnlyHint: t.access === "read", destructiveHint: false, idempotentHint: t.access === "read", openWorldHint: false },
    })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    const data = await atlas<unknown>(`/api/agent/tools/${encodeURIComponent(req.params.name)}`, { method: "POST", body: JSON.stringify(req.params.arguments ?? {}) });
    let text = JSON.stringify(data, null, 2);
    if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}\n… (truncated)`;
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const e = err as Error & { details?: unknown };
    return { isError: true, content: [{ type: "text", text: `${e.message}${e.details ? `\n${JSON.stringify(e.details)}` : ""}` }] };
  }
});

await server.connect(new StdioServerTransport());
process.stderr.write(`[atlas-mcp] connected · ${BASE}\n`);
