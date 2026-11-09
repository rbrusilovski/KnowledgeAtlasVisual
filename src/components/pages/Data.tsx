"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Database, ShieldAlert } from "lucide-react";
import { Page } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Badge, EmptyState, ErrorState, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/misc";
import { reviewProposal } from "@/components/expansion/ProposalReview";
import { api, ApiError } from "@/lib/api";
import type { ProposalDTO } from "@/shared/contracts/expansion";

type Counts = Partial<Record<"PRESENT" | "NOT_RETURNED" | "UNAVAILABLE" | "NOT_APPLICABLE" | "NOT_REQUESTED" | "STALE" | "ERROR" | "EXPIRED", number>>;
interface Coverage {
  channels: { total: number; complete: number; groups: { group: string; counts: Counts }[] };
  videos: { total: number; complete: number; withoutCoverage: number; groups: { group: string; counts: Counts }[] };
  history: { states: Record<string, number>; channelsWithMoreHistory: number; pagesScanned: number; itemsSeen: number; unavailable: number };
  derived: { videosEmbedded: number; videosWithTopics: number; channelsClassified: number };
  retention: { expiringSoon: number; overdue: number; nextDeadline: string | null };
  approvals: { pending: number; running: number };
  policy: { mode: string; liveCollection: boolean; crossOwnerAggregation: boolean; derivedData: boolean; extendedStatisticsRetention: boolean };
}
interface Quota {
  mode: string;
  resetAt: string;
  buckets: { bucket: string; used: number; limit: number; backgroundCap: number; exhausted: boolean }[];
}
interface NicheNode {
  id: string;
  name: string;
  children: { id: string; name: string }[];
}

const STATUS_ORDER = ["PRESENT", "UNAVAILABLE", "NOT_APPLICABLE", "STALE", "NOT_RETURNED", "NOT_REQUESTED", "ERROR", "EXPIRED"] as const;
const TONE: Record<string, string> = {
  PRESENT: "bg-success/70",
  UNAVAILABLE: "bg-text-3/60",
  NOT_APPLICABLE: "bg-text-3/30",
  STALE: "bg-warning/80",
  NOT_RETURNED: "bg-warning/40",
  NOT_REQUESTED: "bg-bg-3",
  ERROR: "bg-danger/80",
  EXPIRED: "bg-danger/40",
};
const LABEL: Record<string, string> = {
  PRESENT: "collected",
  UNAVAILABLE: "not available on YouTube",
  NOT_APPLICABLE: "not applicable",
  STALE: "needs refresh soon",
  NOT_RETURNED: "not returned last time",
  NOT_REQUESTED: "not requested yet",
  ERROR: "error",
  EXPIRED: "expired (deleted)",
};

const n = (x: number) => x.toLocaleString();

function GroupBar({ group, counts }: { group: string; counts: Counts }) {
  const total = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0) || 1;
  return (
    <div className="grid grid-cols-[130px_1fr_64px] items-center gap-3 text-sm">
      <span className="text-text-2">{group.replace(/_/g, " ").toLowerCase()}</span>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-bg-3" role="img" aria-label={STATUS_ORDER.filter((s) => counts[s]).map((s) => `${counts[s]} ${LABEL[s]}`).join(", ")}>
        {STATUS_ORDER.map((s) => (counts[s] ? <div key={s} className={TONE[s]} style={{ width: `${(100 * counts[s]!) / total}%` }} title={`${n(counts[s]!)} ${LABEL[s]}`} /> : null))}
      </div>
      <span className="num text-right text-text-3">{Math.round((100 * ((counts.PRESENT ?? 0) + (counts.UNAVAILABLE ?? 0) + (counts.NOT_APPLICABLE ?? 0) + (counts.STALE ?? 0))) / total)}%</span>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-card border border-border bg-bg-1 p-3">
      <div className="text-xs text-text-3">{label}</div>
      <div className="num mt-1 text-xl font-semibold text-text-1">{value}</div>
      {sub ? <div className="mt-0.5 text-xs text-text-3">{sub}</div> : null}
    </div>
  );
}

function CoveragePanel({ c }: { c: Coverage }) {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Channels" value={n(c.channels.total)} sub={`${n(c.channels.complete)} fully collected`} />
        <Stat label="Videos" value={n(c.videos.total)} sub={`${n(c.videos.complete)} fully collected`} />
        <Stat label="Upload history" value={n(c.history.itemsSeen)} sub={`${c.history.channelsWithMoreHistory} channel(s) have older uploads left`} />
        <Stat label="Retention" value={n(c.retention.expiringSoon)} sub={c.retention.overdue ? `${c.retention.overdue} overdue` : c.retention.nextDeadline ? `next deadline ${new Date(c.retention.nextDeadline).toLocaleDateString()}` : "nothing due"} />
      </div>
      <section className="space-y-2 rounded-card border border-border bg-bg-1 p-4">
        <h2 className="text-sm font-semibold text-text-1">Video fields</h2>
        <p className="text-xs text-text-3">A video counts as collected when identity, text, publication, thumbnails and statistics are resolved (collected, or confirmed unavailable on YouTube). Transcripts are tracked per video but never required.</p>
        {c.videos.groups.map((g) => (
          <GroupBar key={g.group} {...g} />
        ))}
      </section>
      <section className="space-y-2 rounded-card border border-border bg-bg-1 p-4">
        <h2 className="text-sm font-semibold text-text-1">Channel fields</h2>
        {c.channels.groups.map((g) => (
          <GroupBar key={g.group} {...g} />
        ))}
      </section>
      <div className="flex flex-wrap gap-3 text-xs text-text-3">
        {STATUS_ORDER.map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5">
            <span className={`size-2 rounded-full ${TONE[s]}`} />
            {LABEL[s]}
          </span>
        ))}
      </div>
      <section className="grid gap-3 rounded-card border border-border bg-bg-1 p-4 text-sm md:grid-cols-2">
        <div>
          <h2 className="mb-1 font-semibold text-text-1">History states</h2>
          {Object.entries(c.history.states).map(([k, v]) => (
            <div key={k} className="flex justify-between text-text-2">
              <span>{k.replace(/_/g, " ").toLowerCase()}</span>
              <span className="num">{v}</span>
            </div>
          ))}
          <div className="mt-1 text-xs text-text-3">
            {n(c.history.pagesScanned)} playlist pages scanned · {n(c.history.unavailable)} unavailable/private items
          </div>
        </div>
        <div>
          <h2 className="mb-1 font-semibold text-text-1">Atlas-derived data</h2>
          <div className="text-text-2">{n(c.derived.videosEmbedded)} videos embedded · {n(c.derived.videosWithTopics)} with topics · {n(c.derived.channelsClassified)} channels classified</div>
          <div className="mt-1 text-xs text-text-3">Inferred by Atlas from YouTube metadata — not YouTube data.</div>
        </div>
      </section>
    </div>
  );
}

function ProposalRow({ p }: { p: ProposalDTO }) {
  const qc = useQueryClient();
  const running = p.status === "RUNNING" || p.status === "APPROVED";
  const cancel = async () => {
    try {
      await api.post(`/api/expansions/${p.id}/cancel`);
      toast.success("Cancelled — running jobs stop at their next page");
      void qc.invalidateQueries({ queryKey: ["proposals"] });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not cancel");
    }
  };
  return (
    <li className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-2.5 last:border-0" data-testid="proposal-row">
      <button className="min-w-0 flex-1 text-left" onClick={() => reviewProposal(p)}>
        <div className="truncate text-sm text-text-1">{p.title}</div>
        <div className="mt-0.5 text-xs text-text-3">
          {p.source === "CLAUDE" ? "Claude" : p.source === "SYSTEM" ? "Atlas scheduler" : p.source === "CLI" ? "CLI" : "You"} · {new Date(p.createdAt).toLocaleString()} · est. {n(p.estimate.quotaUnits)} units{p.estimate.searchCalls ? ` + ${p.estimate.searchCalls} searches` : ""}
          {p.finishedAt ? ` · actual ${n(p.actual.quotaUnits)} units` : ""}
        </div>
      </button>
      {running ? (
        <span className="num text-xs text-text-2">
          {p.jobs.done + p.jobs.failed}/{p.jobs.total} jobs
        </span>
      ) : null}
      <Badge tone={p.status === "PENDING" ? "warning" : p.status === "COMPLETED" ? "success" : p.status === "FAILED" || p.status === "REJECTED" ? "danger" : "neutral"}>{p.status.toLowerCase()}</Badge>
      {p.canDecide ? (
        <Button size="sm" variant="primary" onClick={() => reviewProposal(p)} data-testid="proposal-review-open">
          Review
        </Button>
      ) : running ? (
        <Button size="sm" variant="ghost" onClick={() => void cancel()}>
          Cancel
        </Button>
      ) : null}
    </li>
  );
}

function Proposals({ status }: { status: string }) {
  const q = useQuery({ queryKey: ["proposals", status], queryFn: () => api.get<ProposalDTO[]>("/api/expansions", { status: status === "history" ? undefined : status, limit: 50 }), refetchInterval: status === "active" ? 5_000 : false });
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Skeleton className="h-24" />;
  const rows = status === "history" ? q.data.filter((p) => !["PENDING", "APPROVED", "RUNNING"].includes(p.status)) : q.data;
  if (!rows.length)
    return <EmptyState icon={<Database />} title={status === "PENDING" ? "Nothing waiting for approval" : status === "active" ? "No collection running" : "No past proposals"} body={status === "PENDING" ? "Adding channels, syncing, backfilling history and refreshes all appear here for your approval first." : undefined} className="rounded-card border border-border" />;
  return <ul className="rounded-card border border-border bg-bg-1">{rows.map((p) => <ProposalRow key={p.id} p={p} />)}</ul>;
}

export function DataPage() {
  const [niche, setNiche] = useState("");
  const atlas = useQuery({ queryKey: ["coverage", "atlas"], queryFn: () => api.get<Coverage>("/api/coverage"), refetchInterval: 30_000 });
  const nicheCov = useQuery({ queryKey: ["coverage", "niche", niche], queryFn: () => api.get<Omit<Coverage, "policy">>(`/api/coverage/niches/${niche}`), enabled: Boolean(niche) });
  const niches = useQuery({ queryKey: ["niches"], queryFn: () => api.get<NicheNode[]>("/api/niches") });
  const quota = useQuery({ queryKey: ["quota"], queryFn: () => api.get<Quota>("/api/quota") });

  if (atlas.error) {
    if (atlas.error instanceof ApiError && atlas.error.status === 401)
      return (
        <Page>
          <EmptyState icon={<Database />} title="Sign in to see data coverage">
            <Button asChild variant="primary">
              <Link href="/signin">Sign in</Link>
            </Button>
          </EmptyState>
        </Page>
      );
    return (
      <Page>
        <ErrorState error={atlas.error} onRetry={() => atlas.refetch()} />
      </Page>
    );
  }
  const c = atlas.data;
  const shown = niche && nicheCov.data ? ({ ...nicheCov.data, policy: c?.policy } as Coverage) : c;
  return (
    <Page wide>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl text-text-1">Data coverage</h1>
          <p className="mt-1 text-sm text-text-2">What Atlas has collected from the YouTube Data API, what is missing and why, and every collection waiting for your approval.</p>
        </div>
        <div className="flex items-center gap-2">
          {quota.data
            ? quota.data.buckets.map((b) => (
                <Badge key={b.bucket} tone={b.exhausted ? "danger" : b.used > b.backgroundCap ? "warning" : "neutral"}>
                  {b.bucket === "search" ? "searches" : "API units"} {n(b.used)}/{n(b.limit)}
                </Badge>
              ))
            : null}
        </div>
      </header>

      {c && c.policy.mode === "live" && !c.policy.liveCollection ? (
        <div className="mb-5 flex gap-2 rounded-card border border-warning/30 bg-warning/10 p-3 text-sm text-text-2">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
          Live YouTube collection is disabled pending a recorded compliance decision (see docs/COMPLIANCE_DECISIONS.md). Existing data is still refreshed only with approval and deleted at its retention deadline.
        </div>
      ) : null}

      <Tabs defaultValue="PENDING">
        <TabsList className="mb-3 px-0">
          <TabsTrigger value="PENDING">Waiting for approval{c?.approvals.pending ? ` (${c.approvals.pending})` : ""}</TabsTrigger>
          <TabsTrigger value="active">Running{c?.approvals.running ? ` (${c.approvals.running})` : ""}</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        {["PENDING", "active", "history"].map((s) => (
          <TabsContent key={s} value={s}>
            <Proposals status={s} />
          </TabsContent>
        ))}
      </Tabs>

      <div className="mb-3 mt-8 flex items-center justify-between gap-3">
        <h2 className="text-lg text-text-1">Coverage</h2>
        <select value={niche} onChange={(e) => setNiche(e.target.value)} className="h-8 rounded-control border border-border bg-bg-2 px-2 text-sm text-text-1" aria-label="Coverage scope">
          <option value="">Entire atlas</option>
          {niches.data?.map((r) => (
            <optgroup key={r.id} label={r.name}>
              <option value={r.id}>{r.name} (all)</option>
              {r.children.map((ch) => (
                <option key={ch.id} value={ch.id}>
                  {ch.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      {shown ? <CoveragePanel c={shown} /> : <Skeleton className="h-64" />}
      <p className="mt-6 text-xs text-text-3">Metadata and statistics from the YouTube Data API. Statistics are shown with the time they were collected.</p>
    </Page>
  );
}
