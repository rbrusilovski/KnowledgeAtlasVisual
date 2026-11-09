"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Bot, Copy, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge, Checkbox, Skeleton } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { fmtDate } from "@/lib/format";
import type { AgentScope, AgentTokenDTO } from "@/shared/contracts/agent";

const SCOPE_INFO: Record<AgentScope, string> = {
  read: "Inspect Atlas: coverage, channels, niches, topics, search, graph (read-only)",
  propose: "Estimate and submit expansion proposals for your review",
  "private-transcripts": "Include your private transcripts in agent search results",
};

/** Settings → Agent access: tokens for Claude (MCP adapter). Agents can inspect and propose; only you can approve. */
export function AgentAccess() {
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: ["agent-tokens"], queryFn: () => api.get<AgentTokenDTO[]>("/api/me/agent-tokens") });
  const [name, setName] = useState("Claude");
  const [scopes, setScopes] = useState<AgentScope[]>(["read", "propose"]);
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toggle = (s: AgentScope, on: boolean) => setScopes((cur) => (on ? [...new Set([...cur, s])] : cur.filter((x) => x !== s)));

  return (
    <div className="space-y-3" data-testid="agent-access">
      <p className="text-xs text-text-3">
        Agents (e.g. Claude through <code className="font-mono">pnpm mcp</code>) can inspect Atlas and submit proposals. Every proposal waits for your
        approval on the Data page — no token can approve one.
      </p>
      <form
        className="space-y-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const r = await api.post<{ token: string; record: AgentTokenDTO }>("/api/me/agent-tokens", { name: name.trim(), scopes });
            setCreated(r.token);
            await qc.invalidateQueries({ queryKey: ["agent-tokens"] });
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Could not create token");
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="flex max-w-md gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Token name" maxLength={80} />
          <Button type="submit" variant="secondary" disabled={busy || !name.trim()} data-testid="create-agent-token">
            <KeyRound /> Create token
          </Button>
        </div>
        <div className="space-y-1">
          {(Object.keys(SCOPE_INFO) as AgentScope[]).map((s) => (
            <label key={s} className="flex items-center gap-2 text-xs text-text-2">
              <Checkbox checked={scopes.includes(s)} disabled={s === "read"} onCheckedChange={(v) => toggle(s, Boolean(v))} aria-label={`Scope ${s}`} />
              <span className="font-mono text-text-1">{s}</span>
              <span className="text-text-3">— {SCOPE_INFO[s]}</span>
            </label>
          ))}
        </div>
      </form>
      {created ? (
        <div className="rounded-md border border-warning/40 bg-bg-2 p-3 text-xs" role="status">
          <div className="mb-1 text-text-1">Copy this token now — it won’t be shown again.</div>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate font-mono text-text-2" data-testid="agent-token-value">{created}</code>
            <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(created).then(() => toast.success("Copied"))} aria-label="Copy token">
              <Copy />
            </Button>
          </div>
          <div className="mt-2 text-text-3">
            Use with <code className="font-mono">ATLAS_AGENT_TOKEN=… pnpm mcp</code>.
          </div>
        </div>
      ) : null}
      {tokens.isPending ? (
        <Skeleton className="h-16" />
      ) : tokens.isError ? (
        <div className="text-xs text-danger">
          Could not load tokens. <button className="underline" onClick={() => void tokens.refetch()}>Retry</button>
        </div>
      ) : tokens.data.length === 0 ? (
        <div className="flex items-center gap-2 text-xs text-text-3"><Bot className="size-4" /> No agent tokens yet.</div>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {tokens.data.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
              <span className="text-text-1">{t.name}</span>
              <code className="font-mono text-text-3">{t.prefix}…</code>
              {t.scopes.map((s) => <Badge key={s}>{s}</Badge>)}
              <span className="text-text-3">created {fmtDate(t.createdAt)}{t.lastUsedAt ? ` · last used ${fmtDate(t.lastUsedAt)}` : " · never used"}</span>
              <span className="ml-auto">
                {t.active ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={async () => {
                      await api.del(`/api/me/agent-tokens/${t.id}`);
                      await qc.invalidateQueries({ queryKey: ["agent-tokens"] });
                      toast.success("Token revoked");
                    }}
                  >
                    Revoke
                  </Button>
                ) : (
                  <Badge tone="danger">{t.revokedAt ? "revoked" : "expired"}</Badge>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
