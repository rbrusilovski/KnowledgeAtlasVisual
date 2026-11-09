"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, ExternalLink, Sparkles, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { useNiches } from "@/lib/hooks";
import { Page } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Badge, ErrorState, Skeleton } from "@/components/ui/misc";
import { Stat } from "@/components/inspector/Inspector";
import { api } from "@/lib/api";
import { fmtInt, fmtRelative } from "@/lib/format";

interface AlertDTO {
  id: string;
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
  action?: string;
}

interface Overview {
  alerts: AlertDTO[];
  quota: { day: string; buckets: { bucket: string; used: number; limit: number; exhausted: boolean }[]; methods: { bucket: string; method: string; calls: number; units: number }[] }[];
  runs: { id: string; kind: string; targetId: string; status: string; unitsUsed: number; searchCalls: number; startedAt: string; finishedAt: string | null; error: string | null }[];
  queues: Record<string, Record<string, number>>;
  failed: { queue: string; id: string; failedReason: string; attemptsMade: number; finishedOn: string | null }[];
  ai: { used: number; budget: number };
  totals: Record<string, number>;
}

function Alerts({ alerts }: { alerts: AlertDTO[] }) {
  return (
    <section className="mt-8" data-testid="admin-alerts">
      <h2 className="mb-2 text-base text-text-1">Alerts</h2>
      {alerts.length === 0 ? (
        <p className="text-sm text-text-3">No active alerts.</p>
      ) : (
        <ul className="divide-y divide-border rounded-card border border-border">
          {alerts.map((a) => (
            <li key={a.id} className="flex flex-wrap items-start gap-3 px-4 py-3 text-sm">
              <Badge tone={a.severity === "critical" ? "danger" : a.severity === "warning" ? "warning" : "neutral"}>{a.severity}</Badge>
              <div className="min-w-0 flex-1">
                <div className="text-text-1">{a.title}</div>
                {a.detail ? <div className="text-xs text-text-3">{a.detail}</div> : null}
                {a.action ? <div className="mt-0.5 text-xs text-text-2">→ {a.action}</div> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function AdminPage() {
  const q = useQuery({ queryKey: ["admin"], queryFn: () => api.get<Overview>("/api/admin/overview"), refetchInterval: 15_000 });
  if (q.isLoading) return <Page wide><Skeleton className="h-96" /></Page>;
  if (q.error) return <Page><ErrorState error={q.error} onRetry={() => q.refetch()} /></Page>;
  const d = q.data!;
  const maxUnits = Math.max(1, ...d.quota.map((day) => day.buckets.find((b) => b.bucket === "general")?.used ?? 0));
  return (
    <Page wide>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl text-text-1">Admin</h1>
        <Button asChild variant="secondary"><a href="/api/admin/queues" target="_blank" rel="noopener noreferrer"><ExternalLink /> Queue dashboard</a></Button>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        {Object.entries(d.totals).map(([k, v]) => <Stat key={k} label={k} value={fmtInt(v)} />)}
      </div>
      <Alerts alerts={d.alerts} />
      <SuggestedSubniches />
      <h2 className="mb-2 mt-8 text-base text-text-1">Quota history (Pacific days)</h2>
      <div className="overflow-x-auto rounded-card border border-border">
        <table className="w-full text-sm">
          <thead className="text-xs text-text-3"><tr><th className="px-3 py-2 text-left">Day</th><th className="px-3 py-2 text-left">General units</th><th className="px-3 py-2 text-left">Searches</th><th className="px-3 py-2 text-left">Top methods</th></tr></thead>
          <tbody>
            {d.quota.map((day) => {
              const g = day.buckets.find((b) => b.bucket === "general")!;
              const s = day.buckets.find((b) => b.bucket === "search")!;
              return (
                <tr key={day.day} className="border-t border-border text-text-2">
                  <td className="num px-3 py-2">{day.day}</td>
                  <td className="px-3 py-2"><div className="flex items-center gap-2"><div className="h-1.5 w-32 rounded-full bg-bg-3"><div className="h-full rounded-full bg-accent-500" style={{ width: `${(g.used / maxUnits) * 100}%` }} /></div><span className="num">{fmtInt(g.used)} / {fmtInt(g.limit)}</span>{g.exhausted ? <Badge tone="danger">exhausted</Badge> : null}</div></td>
                  <td className="num px-3 py-2">{s.used} / {s.limit}</td>
                  <td className="px-3 py-2 text-xs text-text-3">{day.methods.sort((a, b) => b.units - a.units).slice(0, 3).map((m) => `${m.method} ${m.units}`).join(" · ") || "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-text-3">AI tokens today: {fmtInt(d.ai.used)} / {fmtInt(d.ai.budget)}</p>
      <h2 className="mb-2 mt-8 text-base text-text-1">Queues</h2>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {Object.entries(d.queues).map(([name, c]) => (
          <div key={name} className="rounded-card border border-border bg-bg-1 p-3 text-xs">
            <div className="mb-1 text-sm text-text-1">{name}</div>
            <div className="num text-text-3">wait {(c.waiting ?? 0) + (c.prioritized ?? 0)} · active {c.active ?? 0} · delayed {c.delayed ?? 0} · <span className={c.failed ? "text-danger" : ""}>failed {c.failed ?? 0}</span></div>
          </div>
        ))}
      </div>
      <h2 className="mb-2 mt-8 text-base text-text-1">Failed jobs</h2>
      {d.failed.length ? (
        <ul className="divide-y divide-border rounded-card border border-border text-sm">
          {d.failed.map((f) => <li key={`${f.queue}:${f.id}`} className="px-3 py-2"><span className="text-text-1">{f.queue}</span> <span className="num text-text-3">{f.id}</span> · {f.attemptsMade} attempts · {fmtRelative(f.finishedOn)}<div className="text-xs text-danger">{f.failedReason}</div></li>)}
        </ul>
      ) : <p className="text-sm text-text-3">No failed jobs.</p>}
      <h2 className="mb-2 mt-8 text-base text-text-1">Ingestion runs</h2>
      <div className="overflow-x-auto rounded-card border border-border">
        <table className="w-full text-sm">
          <thead className="text-xs text-text-3"><tr><th className="px-3 py-2 text-left">Kind</th><th className="px-3 py-2 text-left">Target</th><th className="px-3 py-2 text-left">Status</th><th className="px-3 py-2 text-left">Units</th><th className="px-3 py-2 text-left">Started</th></tr></thead>
          <tbody>
            {d.runs.map((r) => (
              <tr key={r.id} className="border-t border-border text-text-2">
                <td className="px-3 py-1.5">{r.kind}</td>
                <td className="num px-3 py-1.5 text-xs">{r.targetId}</td>
                <td className="px-3 py-1.5"><Badge tone={r.status === "completed" ? "success" : r.status === "failed" ? "danger" : "neutral"}>{r.status}</Badge>{r.error ? <span className="ml-2 text-xs text-danger">{r.error}</span> : null}</td>
                <td className="num px-3 py-1.5">{r.unitsUsed}{r.searchCalls ? ` + ${r.searchCalls}s` : ""}</td>
                <td className="px-3 py-1.5 text-xs text-text-3">{fmtRelative(r.startedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Page>
  );
}

interface Suggestion {
  id: string;
  name: string;
  keywords: string[];
  parentSlug: string | null;
  parentName: string | null;
  cohesion: number;
  channels: { id: string; youtubeId: string; title: string; thumbnailUrl: string | null; confidence: number; currentNiche: string | null }[];
}

function SuggestedSubniches() {
  const q = useQuery({ queryKey: ["subniche-suggestions"], queryFn: () => api.get<Suggestion[]>("/api/niches/suggestions") });
  return (
    <section className="mt-8" data-testid="suggested-subniches">
      <h2 className="mb-1 text-base text-text-1">Suggested subniches</h2>
      <p className="mb-3 text-sm text-text-3">Clusters of channels the taxonomy fits poorly (low classification confidence), grouped by Louvain over embedding similarity and shared topics. Accepting adds a subniche to the shared taxonomy and reclassifies its members.</p>
      {q.isLoading ? (
        <Skeleton className="h-28" />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : q.data!.length ? (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">{q.data!.map((s) => <SuggestionCard key={s.id} s={s} />)}</div>
      ) : (
        <EmptyState icon={<Sparkles />} title="No suggestions right now" body="Every channel currently fits an existing subniche with reasonable confidence." className="rounded-card border border-border" />
      )}
    </section>
  );
}

function SuggestionCard({ s }: { s: Suggestion }) {
  const niches = useNiches();
  const qc = useQueryClient();
  const [name, setName] = useState(s.name);
  const [parent, setParent] = useState(s.parentSlug ?? "");
  const [busy, setBusy] = useState(false);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["subniche-suggestions"] }), qc.invalidateQueries({ queryKey: ["niches"] })]);
  return (
    <div className="rounded-card border border-border bg-bg-1 p-3" data-testid="suggestion-card">
      <div className="flex flex-wrap items-center gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Subniche name" className="h-8 max-w-64" maxLength={60} />
        <select value={parent} onChange={(e) => setParent(e.target.value)} aria-label="Parent niche" className="h-8 rounded-control border border-border bg-bg-3/60 px-2 text-sm text-text-2">
          <option value="" disabled>Parent niche…</option>
          {niches.data?.map((n) => <option key={n.slug} value={n.slug}>{n.name}</option>)}
        </select>
        <Badge>cohesion {s.cohesion.toFixed(2)}</Badge>
      </div>
      {s.keywords.length ? <p className="mt-2 text-xs text-text-3">Shared topics: {s.keywords.slice(0, 8).join(", ")}</p> : null}
      <ul className="mt-2 flex flex-wrap gap-1.5">
        {s.channels.map((c) => (
          <li key={c.id}>
            <Link href={`/channels/${c.youtubeId}`} className="flex items-center gap-1.5 rounded-full border border-border bg-bg-2 py-0.5 pl-0.5 pr-2 text-xs text-text-2 hover:text-text-1">
              <img src={c.thumbnailUrl ?? ""} alt="" className="size-5 rounded-full" />
              {c.title}
              <span className="num text-text-3">{Math.round(c.confidence * 100)}%</span>
            </Link>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={async () => {
            await api.del(`/api/niches/suggestions/${s.id}`);
            await refresh();
          }}
        >
          <X /> Dismiss
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={busy || name.trim().length < 2 || !parent}
          onClick={async () => {
            setBusy(true);
            try {
              await api.post("/api/niches/suggestions", { channelIds: s.channels.map((c) => c.id), name: name.trim(), parentSlug: parent, keywords: s.keywords });
              toast.success(`Created subniche “${name.trim()}”`);
              await refresh();
            } catch (e) {
              toast.error(e instanceof Error ? e.message : "Could not create subniche");
            } finally {
              setBusy(false);
            }
          }}
        >
          <Check /> Accept
        </Button>
      </div>
    </div>
  );
}
