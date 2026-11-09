"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ShieldCheck, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Dialog, DialogContent } from "@/components/ui/misc";
import { api, ApiError } from "@/lib/api";
import { useQuota } from "@/lib/hooks";
import type { ProposalDTO } from "@/shared/contracts/expansion";

const EVENT = "atlas:review-proposal";

/** Open the review dialog for a proposal from anywhere (add channel, sync, discover, demo load, data page). */
export function reviewProposal(p: ProposalDTO) {
  window.dispatchEvent(new CustomEvent<ProposalDTO>(EVENT, { detail: p }));
}

const fmt = (n: number) => n.toLocaleString();

export function ScopeDetails({ p }: { p: ProposalDTO }) {
  const s = p.scope;
  const rows: [string, string][] = [];
  switch (s.kind) {
    case "ADD_CHANNELS":
      rows.push(["Channels", s.channels.length <= 4 ? s.channels.map((c) => c.youtubeId).join(", ") : `${s.channels.length} channels`], ["Newest uploads per channel", `up to ${fmt(s.maxVideosPerChannel)}`]);
      break;
    case "DISCOVER_CHANNELS":
      rows.push(["Search queries", s.queries.join(" · ")], ["Candidates per query", `up to ${s.maxCandidatesPerQuery}`], ["New channels added", `at most ${s.maxChannelsToAdd}`], ["Uploads per added channel", `up to ${fmt(s.maxVideosPerChannel)}`]);
      if (s.regionCode) rows.push(["Region", s.regionCode]);
      break;
    case "BACKFILL_HISTORY":
      rows.push(["Channel", s.channelYoutubeId], ["History range", "older uploads, continuing from the saved checkpoint"], ["Bound", `≤ ${s.maxPages} pages · ≤ ${fmt(s.maxVideos)} videos`]);
      break;
    case "SYNC_UPLOADS":
      rows.push(["Channels", s.channelYoutubeIds.length <= 3 ? s.channelYoutubeIds.join(", ") : `${s.channelYoutubeIds.length} channels`], ["New uploads per channel", `up to ${s.maxNewVideosPerChannel} (stops at the first known upload)`]);
      break;
    case "REFRESH_METADATA":
      rows.push(["Records", `${fmt(s.channelYoutubeIds.length)} channels · ${fmt(s.videoYoutubeIds.length)} videos`], ["Fields", s.fields === "all" ? "all metadata, thumbnails, statistics, status" : "statistics only"], ["Purpose", s.purpose]);
      break;
  }
  if ("includeTranscripts" in s) rows.push(["Transcripts", s.includeTranscripts ? "fetched where an eligible provider exists" : "not requested"]);
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-text-3">{k}</dt>
          <dd className="break-all text-text-1">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function EstimateLine({ p }: { p: ProposalDTO }) {
  return (
    <div className="grid grid-cols-4 gap-2 text-center">
      {[
        ["channels", p.estimate.channels],
        ["videos (max)", p.estimate.videos],
        ["API units", p.estimate.quotaUnits],
        ["searches", p.estimate.searchCalls],
      ].map(([label, n]) => (
        <div key={label as string} className="rounded-control border border-border bg-bg-2 px-2 py-1.5">
          <div className="num text-md font-semibold text-text-1">{fmt(n as number)}</div>
          <div className="text-[11px] text-text-3">{label}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * Compares the estimate with today's remaining quota. Exceeding it is allowed — jobs pause at the Pacific-midnight
 * reset and resume automatically — but the user should know before approving. Background (SYSTEM) work only gets the
 * background share of the quota.
 */
function QuotaCheck({ p }: { p: ProposalDTO }) {
  const quota = useQuota();
  if (!quota.data || p.status !== "PENDING") return null;
  const general = quota.data.buckets.find((b) => b.bucket === "general");
  const search = quota.data.buckets.find((b) => b.bucket === "search");
  const background = p.source === "SYSTEM";
  const generalLeft = general ? Math.max(0, (background ? general.backgroundCap : general.limit) - general.used) : Infinity;
  const searchLeft = search ? Math.max(0, (background ? search.backgroundCap : search.limit) - search.used) : Infinity;
  const over = p.estimate.quotaUnits > generalLeft || p.estimate.searchCalls > searchLeft;
  return (
    <p className={`text-xs ${over ? "text-warning" : "text-text-3"}`} data-testid="proposal-quota">
      {over
        ? `Exceeds today's remaining ${background ? "background " : ""}quota (${generalLeft.toLocaleString()} units, ${searchLeft} searches). Work pauses at the reset (${new Date(quota.data.resetAt).toLocaleTimeString()}) and resumes automatically.`
        : `Fits today's remaining ${background ? "background " : ""}quota: ${generalLeft.toLocaleString()} units, ${searchLeft} searches.`}
    </p>
  );
}

function ReviewBody({ p, onDone }: { p: ProposalDTO; onDone: () => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const decide = async (action: "approve" | "reject") => {
    setBusy(action);
    try {
      await api.post(`/api/expansions/${p.id}/${action}`, { scopeHash: p.scopeHash });
      toast.success(action === "approve" ? "Approved — collection started" : "Proposal rejected", { description: action === "approve" ? "Progress appears in the status bar and on the Data page." : undefined });
      void qc.invalidateQueries({ queryKey: ["proposals"] });
      void qc.invalidateQueries({ queryKey: ["coverage"] });
      onDone();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not record your decision");
    } finally {
      setBusy(null);
    }
  };
  const expires = new Date(p.expiresAt);
  return (
    <div className="space-y-4" data-testid="proposal-review">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={p.source === "CLAUDE" ? "accent" : p.source === "SYSTEM" ? "warning" : "neutral"}>{p.source === "CLAUDE" ? "Proposed by Claude" : p.source === "SYSTEM" ? "Scheduled by Atlas" : "Your request"}</Badge>
        <Badge>{p.kind.replace(/_/g, " ").toLowerCase()}</Badge>
        <Badge tone={p.status === "PENDING" ? "warning" : p.status === "COMPLETED" ? "success" : p.status === "FAILED" ? "danger" : "neutral"}>{p.status.toLowerCase()}</Badge>
      </div>
      <p className="text-sm text-text-2">{p.reason}</p>
      {p.coverageGap ? <p className="text-sm text-text-3">Gap: {p.coverageGap}</p> : null}
      <ScopeDetails p={p} />
      <EstimateLine p={p} />
      <QuotaCheck p={p} />
      {p.uncertainty ? (
        <p className="flex gap-2 rounded-control border border-border bg-bg-2 p-2 text-xs text-text-2">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
          {p.uncertainty} Figures are estimates; actual usage is recorded after execution.
        </p>
      ) : null}
      <p className="text-xs text-text-3">
        Approval applies to exactly this scope, once{p.status === "PENDING" ? `, and expires ${expires.toLocaleString()}` : ""}. Scope fingerprint <code className="num">{p.scopeHash.slice(0, 12)}</code>
      </p>
      {p.canDecide ? (
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => void decide("reject")} disabled={busy !== null} data-testid="proposal-reject">
            {busy === "reject" ? "Rejecting…" : "Reject"}
          </Button>
          <Button variant="primary" onClick={() => void decide("approve")} disabled={busy !== null} data-testid="proposal-approve">
            <ShieldCheck />
            {busy === "approve" ? "Approving…" : "Approve & run"}
          </Button>
        </div>
      ) : p.status === "PENDING" ? (
        <p className="text-xs text-text-3">Only {p.source === "SYSTEM" ? "an admin" : "the person who requested it"} can approve this proposal.</p>
      ) : null}
    </div>
  );
}

/** Mounted once in the app shell. */
export function ProposalReviewHost() {
  const [p, setP] = useState<ProposalDTO | null>(null);
  useEffect(() => {
    const on = (e: Event) => setP((e as CustomEvent<ProposalDTO>).detail);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return (
    <Dialog open={Boolean(p)} onOpenChange={(o) => !o && setP(null)}>
      {p ? (
        <DialogContent title={p.title} description="Nothing is collected until you approve this exact scope." className="w-[min(94vw,560px)]">
          <ReviewBody p={p} onDone={() => setP(null)} />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
