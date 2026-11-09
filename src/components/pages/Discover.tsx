"use client";

import type { ProposalDTO } from "@/shared/contracts/expansion";
import { reviewProposal } from "@/components/expansion/ProposalReview";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Link2, Loader2, Plus, Search, Sparkles } from "lucide-react";
import { Page } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge, Checkbox, Dialog, DialogContent, EmptyState, Skeleton } from "@/components/ui/misc";
import { AddChannelDialog } from "@/components/layout/AddChannelDialog";
import { api, ApiError } from "@/lib/api";
import { useMe, useNiches, useQuota } from "@/lib/hooks";
import { useLive } from "@/lib/events";
import { fmtCompact } from "@/lib/format";
import { cn } from "@/lib/cn";

interface Discovered {
  youtubeId: string;
  title: string;
  description: string;
  handle: string | null;
  thumbnailUrl: string | null;
  subscriberCount: number | null;
  videoCount: number | null;
  country: string | null;
  inAtlas: boolean;
  atlasChannelId: string | null;
  nicheGuess: { slug: string; name: string; similarity: number } | null;
  url: string;
}
interface DiscoveryResult {
  query: string;
  results: Discovered[];
  quotaUsed: { general: number; search: number };
  cached: boolean;
}

/** ISO 3166-1 alpha-2 regions and ISO 639-1 languages passed to search.list (regionCode / relevanceLanguage). */
const REGIONS: [string, string][] = [
  ["US", "United States"], ["GB", "United Kingdom"], ["CA", "Canada"], ["AU", "Australia"], ["IN", "India"], ["DE", "Germany"],
  ["FR", "France"], ["ES", "Spain"], ["IT", "Italy"], ["NL", "Netherlands"], ["SE", "Sweden"], ["BR", "Brazil"], ["MX", "Mexico"],
  ["JP", "Japan"], ["KR", "South Korea"], ["ID", "Indonesia"], ["PH", "Philippines"], ["NG", "Nigeria"], ["ZA", "South Africa"],
];
const LANGUAGES: [string, string][] = [
  ["en", "English"], ["es", "Spanish"], ["pt", "Portuguese"], ["fr", "French"], ["de", "German"], ["it", "Italian"], ["nl", "Dutch"],
  ["hi", "Hindi"], ["ja", "Japanese"], ["ko", "Korean"], ["zh-Hans", "Chinese (Simplified)"], ["ar", "Arabic"], ["ru", "Russian"], ["id", "Indonesian"],
];

export function DiscoverPage() {
  const sp = useSearchParams();
  const me = useMe();
  const quota = useQuota();
  const niches = useNiches();
  const qc = useQueryClient();
  const live = useLive();
  const [q, setQ] = useState(sp.get("q") ?? "");
  const [nicheSlug, setNicheSlug] = useState(sp.get("niche") ?? "");
  const [result, setResult] = useState<DiscoveryResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState<Map<string, "queued" | "done">>(new Map());
  const [confirmNiche, setConfirmNiche] = useState<{ units: number; queries: string[] } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [region, setRegion] = useState(sp.get("region") ?? "");
  const [language, setLanguage] = useState(sp.get("lang") ?? "");

  const search = quota.data?.buckets.find((b) => b.bucket === "search");
  const user = quota.data?.user;
  const subniches = useMemo(() => niches.data?.flatMap((n) => n.children.map((c) => ({ ...c, parent: n.name }))) ?? [], [niches.data]);
  const niche = subniches.find((s) => s.slug === nicheSlug);

  // Mark results as added when their ingest completes (SSE).
  useEffect(
    () =>
      live.subscribe((ev) => {
        if (ev.type !== "job.completed" || ev.data.queue !== "ingest-channel") return;
        // Approved ingest jobs are `x-<proposalId>-ingest-<UC…>`; the progress payload also carries youtubeId.
        const yt = String(ev.data.youtubeId ?? String(ev.data.jobId).split("-ingest-").pop());
        setAdding((m) => (m.has(yt) ? new Map(m).set(yt, "done") : m));
      }),
    [live],
  );

  const run = useMutation({
    mutationFn: async (opts: { kind: "query" } | { kind: "niche"; confirm?: boolean }) =>
      opts.kind === "query"
        ? api.post<DiscoveryResult>("/api/discover/channels", { query: q.trim(), nicheId: niche?.id, maxResults: 25, regionCode: region || undefined, relevanceLanguage: language || undefined })
        : api.post<DiscoveryResult>(`/api/discover/niche/${nicheSlug}`, { confirm: opts.confirm, maxResults: 15, regionCode: region || undefined }),
    onSuccess: (r) => {
      setResult(r);
      setSelected(new Set());
      void qc.invalidateQueries({ queryKey: ["quota"] });
      toast(r.cached ? "Served from cache — no searches used" : `Used ${r.quotaUsed.search} search${r.quotaUsed.search === 1 ? "" : "es"} · ${r.quotaUsed.general} units`);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === "NEEDS_CONFIRMATION") {
        const d = e.details as { needsConfirmation: { cost: { units: number } }; queries: string[] };
        setConfirmNiche({ units: d.needsConfirmation.cost.units, queries: d.queries });
      } else toast.error(e.message);
    },
  });

  /** Bounded discovery under approval: the proposal states searches used and the maximum channels/videos added. */
  const proposeDiscovery = async () => {
    try {
      const p = niche && !q.trim()
        ? await api.post<ProposalDTO>(`/api/discover/niche/${niche.slug}/propose`, { regionCode: region || undefined })
        : await api.post<ProposalDTO>("/api/expansions", {
            scope: { kind: "DISCOVER_CHANNELS", queries: [q.trim()], nicheId: niche?.id, regionCode: region || undefined, relevanceLanguage: language || undefined, maxCandidatesPerQuery: 15, maxChannelsToAdd: 5, maxVideosPerChannel: 100, includeTranscripts: true },
            reason: `Requested by you: find up to 5 new channels for “${q.trim()}”.`,
          });
      reviewProposal(p);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create the proposal");
    }
  };

  /** One ADD_CHANNELS proposal for the selection; the review dialog shows scope + cost before anything runs. */
  const addChannels = async (ids: string[]) => {
    try {
      const p = await api.post<ProposalDTO>("/api/expansions", {
        scope: { kind: "ADD_CHANNELS", channels: ids.map((youtubeId) => ({ youtubeId, aliases: [] })), maxVideosPerChannel: 300, includeTranscripts: true },
        reason: `Selected on the Discover page (${ids.length} channel${ids.length > 1 ? "s" : ""}).`,
        coverageGap: "Channels found by discovery that are not in the atlas yet.",
      });
      setAdding((m) => {
        const n = new Map(m);
        ids.forEach((id) => n.set(id, "queued"));
        return n;
      });
      reviewProposal(p);
      setSelected(new Set());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create the proposal");
    }
  };

  if (me.data === null)
    return (
      <Page>
        <EmptyState icon={<Sparkles />} title="Sign in to discover channels" body="Discovery uses the YouTube Data API search quota, so it's limited to signed-in users.">
          <Button asChild variant="primary">
            <Link href="/signin?next=/discover">Sign in</Link>
          </Button>
        </EmptyState>
      </Page>
    );

  return (
    <Page wide>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl text-text-1">Discover channels</h1>
          <p className="mt-1 text-sm text-text-2">Search YouTube for channels in a niche and add them to your atlas.</p>
        </div>
        <Button variant="secondary" onClick={() => setAddOpen(true)}>
          <Link2 /> Add by URL
        </Button>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim().length >= 2) run.mutate({ kind: "query" });
        }}
        className="flex flex-wrap items-center gap-2"
      >
        <div className="relative min-w-72 flex-1">
          <Search className="absolute left-2.5 top-2.5 size-4 text-text-3" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. sourdough baking, kubernetes tutorials…" className="h-9 pl-8" aria-label="Search query" data-testid="discover-input" />
        </div>
        <select value={nicheSlug} onChange={(e) => setNicheSlug(e.target.value)} className="h-9 rounded-control border border-border bg-bg-3/60 px-2 text-sm text-text-2" aria-label="Subniche">
          <option value="">Any niche</option>
          {niches.data?.map((n) => (
            <optgroup key={n.id} label={n.name}>
              {n.children.map((c) => (
                <option key={c.id} value={c.slug}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <select value={region} onChange={(e) => setRegion(e.target.value)} className="h-9 rounded-control border border-border bg-bg-3/60 px-2 text-sm text-text-2" aria-label="Region" data-testid="discover-region">
          <option value="">Any region</option>
          {REGIONS.map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
        <select value={language} onChange={(e) => setLanguage(e.target.value)} className="h-9 rounded-control border border-border bg-bg-3/60 px-2 text-sm text-text-2" aria-label="Language" data-testid="discover-language">
          <option value="">Any language</option>
          {LANGUAGES.map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
        <Button type="submit" variant="primary" className="h-9" disabled={q.trim().length < 2 || run.isPending} data-testid="discover-submit">
          {run.isPending ? <Loader2 className="animate-spin" /> : <Search />} Search YouTube
        </Button>
        {niche ? (
          <Button type="button" variant="secondary" className="h-9" onClick={() => run.mutate({ kind: "niche" })} disabled={run.isPending}>
            <Sparkles /> Run {niche.name} queries
          </Button>
        ) : null}
        {niche || q.trim().length >= 2 ? (
          <Button type="button" variant="outline" className="h-9" onClick={() => void proposeDiscovery()} data-testid="discover-propose" title="Searches and adds new channels automatically — only after you approve the bounded proposal">
            <Plus /> Propose auto-add
          </Button>
        ) : null}
      </form>
      <p className="mt-2 text-xs text-text-3" data-testid="discover-cost">
        Uses 1 of {search?.limit ?? 100} daily searches ({search ? search.remaining : "…"} left{user ? ` · you: ${user.cap - user.used} of ${user.cap}` : ""}). Repeated queries are served from cache for 24 h at no cost.
      </p>

      <div className="mt-6">
        {run.isPending ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-36 rounded-card" />)}</div>
        ) : result ? (
          result.results.length ? (
            <>
              <div className="mb-3 flex items-center gap-3 text-sm">
                <span className="text-text-2">
                  {result.results.length} channels for <span className="text-text-1">“{result.query}”</span>
                </span>
                {result.cached ? <Badge>cached</Badge> : <Badge tone="accent">{result.quotaUsed.search} search · {result.quotaUsed.general} units</Badge>}
                {selected.size ? (
                  <Button size="sm" variant="primary" className="ml-auto" onClick={() => void addChannels([...selected])}>
                    <Plus /> Add {selected.size} to atlas
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected(new Set(result.results.filter((r) => !r.inAtlas && !adding.has(r.youtubeId)).map((r) => r.youtubeId)))}>
                    Select all new
                  </Button>
                )}
              </div>
              <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="discover-results">
                {result.results.map((r) => {
                  const state = r.inAtlas ? "done" : adding.get(r.youtubeId);
                  return (
                    <li key={r.youtubeId} className={cn("flex flex-col rounded-card border border-border bg-bg-1 p-3", selected.has(r.youtubeId) && "border-accent-500")}>
                      <div className="flex items-start gap-3">
                        <img src={r.thumbnailUrl ?? ""} alt="" className="size-11 shrink-0 rounded-full border border-border bg-bg-3" />
                        <div className="min-w-0 flex-1">
                          <a href={r.url} target="_blank" rel="noopener noreferrer" className="block truncate text-sm font-medium text-text-1 hover:text-accent-300">
                            {r.title}
                          </a>
                          <div className="num truncate text-xs text-text-3">
                            {r.handle ? `@${r.handle} · ` : ""}
                            {fmtCompact(r.subscriberCount)} subs · {fmtCompact(r.videoCount)} videos{r.country ? ` · ${r.country}` : ""}
                          </div>
                        </div>
                        {!state ? <Checkbox checked={selected.has(r.youtubeId)} onCheckedChange={(v) => setSelected((s) => { const x = new Set(s); if (v) x.add(r.youtubeId); else x.delete(r.youtubeId); return x; })} aria-label={`Select ${r.title}`} /> : null}
                      </div>
                      <p className="mt-2 line-clamp-2 text-[13px] text-text-2">{r.description}</p>
                      <div className="mt-auto flex items-center gap-2 pt-3">
                        {r.nicheGuess ? <Badge tone="accent">{r.nicheGuess.name}</Badge> : null}
                        <div className="ml-auto">
                          {state === "done" ? (
                            <Badge tone="success">
                              <Check className="size-3" /> In atlas
                            </Badge>
                          ) : state === "queued" ? (
                            <Badge>
                              <Loader2 className="size-3 animate-spin" /> Requested…
                            </Badge>
                          ) : (
                            <Button size="sm" variant="secondary" onClick={() => void addChannels([r.youtubeId])} data-testid="add-to-atlas">
                              <Plus /> Add to atlas
                            </Button>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <EmptyState icon={<Search />} title="No channels found" body="Try a broader query or a different niche." />
          )
        ) : (
          <EmptyState icon={<Sparkles />} title="Search YouTube for channels" body="Each new search uses one call from the daily search budget. Results show stats, a niche guess and whether the channel is already in your atlas." />
        )}
      </div>
      <p className="mt-8 text-xs text-text-3">Channel data from the YouTube Data API.</p>

      <Dialog open={Boolean(confirmNiche)} onOpenChange={(o) => !o && setConfirmNiche(null)}>
        <DialogContent title={`Run ${niche?.name ?? "niche"} discovery?`} description={`This runs ${confirmNiche?.queries.length ?? 0} YouTube searches and uses ${confirmNiche?.units ?? 0} of today's search budget.`}>
          <ul className="mb-4 list-disc space-y-0.5 pl-5 text-sm text-text-2">
            {confirmNiche?.queries.map((x) => <li key={x}>{x}</li>)}
          </ul>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmNiche(null)}>Cancel</Button>
            <Button variant="primary" onClick={() => (setConfirmNiche(null), run.mutate({ kind: "niche", confirm: true }))}>
              Use {confirmNiche?.units} searches
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <AddChannelDialog open={addOpen} onOpenChange={setAddOpen} />
    </Page>
  );
}
