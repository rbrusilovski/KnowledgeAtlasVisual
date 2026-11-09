"use client";

import type { ProposalDTO } from "@/shared/contracts/expansion";
import { reviewProposal } from "@/components/expansion/ProposalReview";
import { useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Database, ExternalLink, History, Network, Pencil, RefreshCw, Search, X } from "lucide-react";
import { Page } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge, Dialog, DialogContent, EmptyState, ErrorState, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger, Checkbox } from "@/components/ui/misc";
import { Highlight, Linkified } from "@/components/ui/highlight";
import { AddToCollectionMenu, NicheChips, PanelSkeleton, RelatedList, Stat, VideoRow } from "@/components/inspector/Inspector";
import { MiniGraph } from "./MiniGraph";
import { api } from "@/lib/api";
import { useMe, useNiches } from "@/lib/hooks";
import { fmtCompact, fmtDate, fmtRelative, fmtTimestamp } from "@/lib/format";
import { cn } from "@/lib/cn";
import type { SearchHit } from "@/shared/contracts/search";
import type { RelatedCreator } from "@/shared/contracts/graph";

interface ChannelDetail {
  dataOrigin?: "YOUTUBE" | "FIXTURE";
  attribution?: string;
  id: string;
  youtubeId: string;
  nodeId: string;
  title: string;
  handle: string | null;
  thumbnailUrl: string | null;
  description: string;
  subscriberCount: number | null;
  videoCount: number | null;
  viewCount: number | null;
  country: string | null;
  publishedAt: string | null;
  keywords: string[];
  url: string;
  syncTier: string;
  lastSyncedAt: string | null;
  hasMoreHistory: boolean;
  transcriptCount: number;
  niches: { id: string; slug: string; name: string; confidence: number; method: string; lowConfidence: boolean; rationale: string | null; parent: { slug: string; name: string } | null }[];
  topics: { nodeId: string; label: string; weight: number; videos: number }[];
  lastRun: { kind: string; startedAt: string; finishedAt: string | null; unitsUsed: number; searchCalls: number } | null;
}
interface Facets {
  total: number;
  duration: Record<"short" | "lt10" | "10to30" | "gt30", number>;
  hasTranscript: number;
  dateRange: { min: string | null; max: string | null };
  maxViews: number;
}

const DURATIONS: [string, string][] = [
  ["", "Any length"],
  ["short", "Shorts"],
  ["lt10", "< 10 min"],
  ["10to30", "10–30 min"],
  ["gt30", "> 30 min"],
];

export function ChannelPage({ id }: { id: string }) {
  const q = useQuery({ queryKey: ["channel", id], queryFn: () => api.get<ChannelDetail>(`/api/channels/${id}`) });
  const me = useMe();
  const [overrideOpen, setOverrideOpen] = useState(false);
  if (q.isLoading)
    return (
      <Page wide>
        <PanelSkeleton rows={8} />
      </Page>
    );
  if (q.error)
    return (
      <Page>
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </Page>
    );
  const c = q.data!;
  const sync = async (full: boolean) => {
    try {
      reviewProposal(await api.post<ProposalDTO>(`/api/channels/${c.youtubeId}/sync`, { full }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sync failed");
    }
  };
  const refresh = async () => {
    try {
      reviewProposal(await api.post<ProposalDTO>(`/api/channels/${c.youtubeId}/refresh`, { fields: "all" }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sync failed");
    }
  };
  return (
    <Page wide>
      <header className="flex flex-wrap items-start gap-5">
        <img src={c.thumbnailUrl ?? ""} alt="" className="size-20 rounded-full border border-border bg-bg-3" />
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl text-text-1">
            {c.title}
            {c.dataOrigin === "FIXTURE" ? (
              <Badge tone="warning" className="ml-2 align-middle">
                Demo · fictional
              </Badge>
            ) : null}
          </h1>
          <div className="mt-1 text-sm text-text-3">
            {c.handle ? `@${c.handle}` : c.youtubeId}
            {c.country ? ` · ${c.country}` : ""}
            {c.publishedAt ? ` · since ${fmtDate(c.publishedAt)}` : ""}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <NicheChips niches={c.niches} />
            {me.data ? (
              <button onClick={() => setOverrideOpen(true)} className="flex items-center gap-1 text-xs text-text-3 hover:text-text-1">
                <Pencil className="size-3" /> Edit niches
              </button>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <AddToCollectionMenu nodeIds={[c.nodeId]} />
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/atlas?mode=local&focus=${encodeURIComponent(c.nodeId)}&depth=2`}>
              <Network /> Show in atlas
            </Link>
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <a href={c.url} target="_blank" rel="noopener noreferrer">
              <ExternalLink /> YouTube
            </a>
          </Button>
          {me.data ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => void sync(false)} title="Check for new uploads (needs approval)">
                <RefreshCw /> Sync
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void refresh()} title="Re-fetch all stored metadata (needs approval)" data-testid="channel-refresh">
                <Database /> Refresh metadata
              </Button>
              {c.hasMoreHistory ? (
                <Button variant="ghost" size="sm" onClick={() => void sync(true)}>
                  <History /> Load full history
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      </header>
      <HistoryPanel id={c.youtubeId} />

      <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Subscribers" value={fmtCompact(c.subscriberCount)} />
        <Stat label="Videos" value={fmtCompact(c.videoCount)} />
        <Stat label="Views" value={fmtCompact(c.viewCount)} />
        <Stat label="Transcripts" value={c.transcriptCount} />
        <Stat label="Sync" value={<span className="text-sm">{c.syncTier.toLowerCase()} · {fmtRelative(c.lastSyncedAt)}</span>} />
      </div>
      <p className="mt-2 text-xs text-text-3">
        {c.lastRun ? `Last synced ${fmtRelative(c.lastRun.finishedAt ?? c.lastRun.startedAt)} · ${c.lastRun.unitsUsed} units${c.lastRun.searchCalls ? ` · ${c.lastRun.searchCalls} searches` : ""}` : "Not synced yet"} · Data from the YouTube Data API
      </p>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">
        <Tabs defaultValue="videos" className="min-w-0">
          <TabsList className="px-0">
            <TabsTrigger value="videos">Videos</TabsTrigger>
            <TabsTrigger value="transcripts">Transcript search</TabsTrigger>
            <TabsTrigger value="topics">Topics</TabsTrigger>
            <TabsTrigger value="about">About</TabsTrigger>
          </TabsList>
          <TabsContent value="videos" className="pt-4">
            <ChannelVideos id={c.youtubeId} />
          </TabsContent>
          <TabsContent value="transcripts" className="pt-4">
            <TranscriptSearch channelId={c.youtubeId} count={c.transcriptCount} />
          </TabsContent>
          <TabsContent value="topics" className="pt-4">
            {c.topics.length ? (
              <div className="flex flex-wrap gap-2">
                {c.topics.map((t) => (
                  <Link key={t.nodeId} href={`/atlas?mode=local&focus=${encodeURIComponent(t.nodeId)}&depth=2`}>
                    <Badge className="h-7 px-2.5 text-sm">
                      {t.label} <span className="num text-text-3">{t.videos}</span>
                    </Badge>
                  </Link>
                ))}
              </div>
            ) : (
              <EmptyState title="No topics yet" />
            )}
          </TabsContent>
          <TabsContent value="about" className="space-y-4 pt-4">
            <p className="whitespace-pre-line text-sm leading-relaxed text-text-2">
              <Linkified text={c.description} />
            </p>
            {c.keywords.length ? (
              <div className="flex flex-wrap gap-1">
                {c.keywords.map((k) => <Badge key={k}>{k}</Badge>)}
              </div>
            ) : null}
            {c.niches.map((n) => (
              <div key={n.slug} className="text-xs text-text-3">
                <span className="text-text-2">{n.name}</span> — {(n.confidence * 100).toFixed(0)}% via {n.method.toLowerCase()}
                {n.rationale ? `: ${n.rationale}` : ""}
              </div>
            ))}
          </TabsContent>
        </Tabs>
        <aside className="space-y-4">
          <div>
            <h2 className="mb-2 text-sm font-medium text-text-2">Local graph</h2>
            <MiniGraph focus={c.nodeId} />
          </div>
          <div>
            <h2 className="mb-2 text-sm font-medium text-text-2">Related creators</h2>
            <Related id={c.youtubeId} />
          </div>
        </aside>
      </div>
      {overrideOpen ? <NicheOverride channel={c} onClose={() => setOverrideOpen(false)} /> : null}
    </Page>
  );
}

function Related({ id }: { id: string }) {
  const q = useQuery({ queryKey: ["related", id], queryFn: () => api.get<RelatedCreator[]>(`/api/channels/${id}/related`) });
  return <RelatedList q={q} />;
}

function ChannelVideos({ id }: { id: string }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"recent" | "views" | "relevance">("recent");
  const [duration, setDuration] = useState("");
  const [hasTranscript, setHasTranscript] = useState(false);
  const [after, setAfter] = useState("");
  const [minViews, setMinViews] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [pages, setPages] = useState<string[]>([]);
  const query = {
    q: q.trim() || undefined,
    sort: q.trim() && sort === "recent" ? "relevance" : sort,
    duration: duration || undefined,
    hasTranscript: hasTranscript || undefined,
    publishedAfter: after || undefined,
    minViews: minViews ? Number(minViews) : undefined,
    limit: 25,
    cursor: cursor ?? undefined,
  };
  const r = useQuery({ queryKey: ["channel-videos-page", id, query], queryFn: () => api.getWithMeta<SearchHit[]>(`/api/channels/${id}/videos`, query) });
  const facets = r.data?.meta?.facets as Facets | undefined;
  const reset = () => (setCursor(null), setPages([]));
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-64 flex-1">
          <Search className="absolute left-2.5 top-2 size-4 text-text-3" />
          <Input value={q} onChange={(e) => (setQ(e.target.value), reset())} placeholder="Search within this channel…" className="pl-8" aria-label="Search within channel" data-testid="channel-search" />
          {q ? (
            <button className="absolute right-2 top-2 text-text-3 hover:text-text-1" onClick={() => (setQ(""), reset())} aria-label="Clear search">
              <X className="size-4" />
            </button>
          ) : null}
        </div>
        <select value={sort} onChange={(e) => (setSort(e.target.value as typeof sort), reset())} className="h-8 rounded-control border border-border bg-bg-3/60 px-2 text-sm text-text-2" aria-label="Sort">
          <option value="recent">Most recent</option>
          <option value="views">Most viewed</option>
          <option value="relevance">Relevance</option>
        </select>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        {DURATIONS.map(([v, l]) => (
          <button key={v} onClick={() => (setDuration(v), reset())} className={cn("h-7 rounded-control border px-2.5 text-xs", duration === v ? "border-accent-500 bg-accent-500/15 text-accent-300" : "border-border text-text-2 hover:text-text-1")}>
            {l}
            {v && facets ? <span className="num ml-1 text-text-3">{facets.duration[v as keyof Facets["duration"]]}</span> : null}
          </button>
        ))}
        <label className="ml-2 flex items-center gap-1.5 text-xs text-text-2">
          <Checkbox checked={hasTranscript} onCheckedChange={(v) => (setHasTranscript(Boolean(v)), reset())} aria-label="Has transcript" />
          Has transcript {facets ? <span className="num text-text-3">{facets.hasTranscript}</span> : null}
        </label>
        <label className="flex items-center gap-1.5 text-xs text-text-3">
          After
          <input type="date" value={after} onChange={(e) => (setAfter(e.target.value), reset())} className="h-7 rounded-control border border-border bg-bg-3/60 px-1.5 text-xs text-text-2" aria-label="Published after" />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-text-3">
          Min views
          <input type="number" min={0} value={minViews} onChange={(e) => (setMinViews(e.target.value), reset())} className="num h-7 w-24 rounded-control border border-border bg-bg-3/60 px-1.5 text-xs text-text-2" aria-label="Minimum views" />
        </label>
      </div>
      <div className="mt-4" data-testid="channel-videos">
        {r.isLoading ? (
          <PanelSkeleton rows={6} />
        ) : r.error ? (
          <ErrorState error={r.error} onRetry={() => r.refetch()} />
        ) : r.data!.data.length ? (
          <div className="grid grid-cols-1 gap-1 xl:grid-cols-2">
            {r.data!.data.map((v) => <VideoRow key={v.id} v={v} />)}
          </div>
        ) : (
          <EmptyState icon={<Search />} title="No videos match" body="Try clearing filters or a different query." />
        )}
      </div>
      <div className="mt-3 flex items-center justify-between text-xs text-text-3">
        <span>{facets ? `${facets.total} videos in the atlas` : ""}</span>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" disabled={!pages.length} onClick={() => setPages((p) => (setCursor(p.at(-2) ?? null), p.slice(0, -1)))}>
            Previous
          </Button>
          <Button size="sm" variant="ghost" disabled={!r.data?.meta?.nextCursor} onClick={() => { const n = r.data!.meta!.nextCursor as string; setPages((p) => [...p, n]); setCursor(n); }}>
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}

function TranscriptSearch({ channelId, count }: { channelId: string; count: number }) {
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const r = useQuery({ queryKey: ["channel-transcripts", channelId, submitted], queryFn: () => api.get<SearchHit[]>("/api/search", { q: submitted, types: ["transcript"], channelId, mode: "hybrid", limit: 20 }), enabled: Boolean(submitted) });
  if (!count) return <EmptyState title="No transcripts for this channel" body="Transcripts come from channel owners (OAuth), user uploads on a video page, or the demo dataset." />;
  return (
    <div>
      <form onSubmit={(e) => (e.preventDefault(), setSubmitted(q.trim()))} className="flex gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${count} transcripts…`} aria-label="Search transcripts" />
        <Button type="submit" variant="secondary" disabled={!q.trim()}>
          Search
        </Button>
      </form>
      <div className="mt-4 space-y-3">
        {r.isLoading ? <PanelSkeleton rows={4} /> : null}
        {r.data?.length === 0 ? <EmptyState title="No transcript matches" /> : null}
        {r.data?.map((hit) => (
          <div key={hit.id} className="rounded-card border border-border bg-bg-1 p-3">
            <Link href={`/videos/${hit.nodeId.slice(6)}`} className="text-sm font-medium text-text-1 hover:text-accent-300">
              {hit.title}
            </Link>
            <ul className="mt-2 space-y-1.5">
              {hit.chunks?.map((c) => (
                <li key={c.chunkId} className="flex gap-2 text-[13px]">
                  <Link href={`/videos/${hit.nodeId.slice(6)}?t=${Math.floor(c.startSec)}`} className="num shrink-0 text-accent-300 hover:underline">
                    {fmtTimestamp(c.startSec)}
                  </Link>
                  <Highlight text={c.text} className="text-text-2" />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

function NicheOverride({ channel, onClose }: { channel: ChannelDetail; onClose: () => void }) {
  const niches = useNiches();
  const qc = useQueryClient();
  const manual = channel.niches.filter((n) => n.method === "MANUAL").map((n) => n.slug);
  const [picked, setPicked] = useState<Set<string>>(new Set(manual.length ? manual : channel.niches.map((n) => n.slug)));
  const save = async (slugs: string[]) => {
    try {
      await api.patch(`/api/channels/${channel.youtubeId}/niches`, { nicheIds: slugs });
      toast.success(slugs.length ? "Niches updated (manual override)" : "Override cleared — reclassified automatically");
      await qc.invalidateQueries({ queryKey: ["channel", channel.youtubeId] });
      await qc.invalidateQueries({ queryKey: ["channel", channel.id] });
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save");
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Edit niches" description="Manual assignments always win and survive reclassification. Pick up to 5 subniches.">
        <div className="max-h-[50vh] space-y-3 overflow-y-auto pr-1">
          {niches.data?.map((n) => (
            <div key={n.id}>
              <div className="mb-1 text-xs text-text-3">{n.name}</div>
              <div className="flex flex-wrap gap-1.5">
                {n.children.map((c) => (
                  <button
                    key={c.slug}
                    onClick={() => setPicked((s) => { const x = new Set(s); if (x.has(c.slug)) x.delete(c.slug); else if (x.size < 5) x.add(c.slug); return x; })}
                    className={cn("h-7 rounded-control border px-2 text-xs", picked.has(c.slug) ? "border-accent-500 bg-accent-500/15 text-accent-300" : "border-border text-text-2 hover:text-text-1")}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {niches.isLoading ? <Skeleton className="h-32" /> : null}
        </div>
        <div className="mt-4 flex justify-between">
          <Button variant="ghost" onClick={() => void save([])} disabled={!manual.length}>
            Reset to automatic
          </Button>
          <Button variant="primary" onClick={() => void save([...picked])} disabled={!picked.size}>
            Save override
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface ChannelCoverage {
  complete: boolean;
  groups: { group: string; status: string; reason: string | null; lastSuccessAt: string | null }[];
  history: { state: string; itemsSeen: number; videosCollected: number; unavailable: number; pagesScanned: number; oldestPublishedAt: string | null; newestPublishedAt: string | null; reportedVideoCount: number | null; remainingEstimate: number | null; hasMore: boolean; gap: number; lastError: string | null } | null;
  videos: { total: number; complete: number };
  proposals: { id: string; kind: string; status: string; title: string }[];
}

const HISTORY_LABEL: Record<string, string> = {
  NOT_STARTED: "not started",
  INITIAL_WINDOW_COLLECTED: "latest uploads collected",
  BACKFILL_IN_PROGRESS: "collecting older uploads",
  PAUSED_AWAITING_APPROVAL: "paused — approve another backfill to continue",
  COMPLETE_TO_SOURCE_LIMIT: "complete",
  FAILED_RETRYABLE: "interrupted — will resume from its checkpoint",
  SOURCE_UNAVAILABLE: "no uploads playlist",
};

/** Upload-history progress + field coverage for this channel (read-only). */
function HistoryPanel({ id }: { id: string }) {
  const q = useQuery({ queryKey: ["coverage", "channel", id], queryFn: () => api.get<ChannelCoverage>(`/api/channels/${id}/coverage`) });
  const c = q.data;
  if (!c) return null;
  const h = c.history;
  return (
    <section className="mt-5 grid gap-3 rounded-card border border-border bg-bg-1 p-4 text-sm md:grid-cols-[1.3fr_1fr]" data-testid="channel-history">
      <div>
        <div className="text-xs text-text-3">Upload history</div>
        {h ? (
          <>
            <div className="mt-1 text-text-1">
              <span className="num">{h.itemsSeen.toLocaleString()}</span>
              {h.reportedVideoCount !== null ? <span className="text-text-3"> of {h.reportedVideoCount.toLocaleString()} uploads reported by YouTube</span> : " uploads scanned"} · {HISTORY_LABEL[h.state] ?? h.state}
            </div>
            <div className="mt-1 text-xs text-text-3">
              {h.oldestPublishedAt ? `${fmtDate(h.oldestPublishedAt)} → ${fmtDate(h.newestPublishedAt ?? h.oldestPublishedAt)}` : null}
              {h.pagesScanned ? ` · ${h.pagesScanned} pages` : ""}
              {h.unavailable ? ` · ${h.unavailable} private/unavailable` : ""}
              {h.remainingEstimate ? ` · ~${h.remainingEstimate.toLocaleString()} remaining` : ""}
            </div>
            {h.lastError ? <div className="mt-1 text-xs text-warning">{h.lastError}</div> : null}
            {h.gap > 0 ? (
              <div className="mt-2 flex items-center gap-2 text-xs text-warning">
                {h.gap} reported upload(s) were not seen in the last scan.
                <Button size="sm" variant="outline" className="h-6" onClick={async () => { try { reviewProposal(await api.post<ProposalDTO>(`/api/channels/${id}/sync`, { full: true })); } catch (e) { toast.error(e instanceof Error ? e.message : "Could not propose a re-scan"); } }}>
                  Propose re-scan
                </Button>
              </div>
            ) : null}
          </>
        ) : (
          <div className="mt-1 text-text-2">Not collected yet</div>
        )}
        {c.proposals.length ? <div className="mt-2 text-xs text-text-2">{c.proposals.length} proposal(s) pending or running for this channel — see <Link href="/data" className="text-accent-300 hover:underline">Data</Link>.</div> : null}
      </div>
      <div>
        <div className="text-xs text-text-3">Videos fully collected</div>
        <div className="num mt-1 text-text-1">
          {c.videos.complete.toLocaleString()} / {c.videos.total.toLocaleString()}
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          {c.groups.map((g) => (
            <Badge key={g.group} tone={g.status === "PRESENT" ? "success" : g.status === "STALE" || g.status === "NOT_RETURNED" ? "warning" : g.status === "ERROR" ? "danger" : "neutral"} title={g.reason ?? undefined}>
              {g.group.replace(/_/g, " ").toLowerCase()}
            </Badge>
          ))}
        </div>
      </div>
    </section>
  );
}
