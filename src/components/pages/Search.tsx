"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Hash, Layers, Network, Search as SearchIcon, Tv, Video, FileText } from "lucide-react";
import { Page } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge, EmptyState, ErrorState, Skeleton } from "@/components/ui/misc";
import { Highlight } from "@/components/ui/highlight";
import { apiFetch } from "@/lib/api";
import { fmtCompact, fmtRelative, fmtTimestamp } from "@/lib/format";
import { cn } from "@/lib/cn";
import type { SearchHit, SearchMode, SearchType } from "@/shared/contracts/search";

const TABS: { key: "all" | SearchType; label: string; icon: typeof Tv }[] = [
  { key: "all", label: "All", icon: SearchIcon },
  { key: "channel", label: "Channels", icon: Tv },
  { key: "video", label: "Videos", icon: Video },
  { key: "transcript", label: "Transcripts", icon: FileText },
  { key: "topic", label: "Topics", icon: Hash },
  { key: "niche", label: "Niches", icon: Layers },
];
const MODES: SearchMode[] = ["hybrid", "keyword", "semantic"];

export function SearchPage() {
  const sp = useSearchParams();
  const router = useRouter();
  const q = sp.get("q") ?? "";
  const type = (sp.get("type") ?? "all") as "all" | SearchType;
  const mode = (sp.get("mode") ?? "hybrid") as SearchMode;
  const set = (patch: Record<string, string | null>) => {
    const u = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) u.set(k, v);
      else u.delete(k);
    }
    router.replace(`/search?${u.toString()}`);
  };

  const r = useInfiniteQuery({
    queryKey: ["search-page", q, type, mode],
    enabled: q.trim().length > 0,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => apiFetch<SearchHit[]>("/api/search", { query: { q, mode, types: type === "all" ? undefined : [type], limit: 20, cursor: pageParam } }),
    getNextPageParam: (last) => (last.meta?.nextCursor as string | null) ?? undefined,
  });
  const hits = r.data?.pages.flatMap((p) => p.data) ?? [];
  const meta = r.data?.pages[0]?.meta as { counts?: Record<string, number>; effectiveMode?: SearchMode; ms?: number } | undefined;

  return (
    <Page>
      <SearchForm key={q} initial={q} onSubmit={(v) => set({ q: v || null })} />
      <div className="mt-4 flex flex-wrap items-center gap-1 border-b border-border">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => set({ type: t.key === "all" ? null : t.key })} className={cn("relative flex h-9 items-center gap-1.5 px-2.5 text-sm", type === t.key ? "text-text-1 after:absolute after:inset-x-1 after:-bottom-px after:h-0.5 after:bg-accent-500" : "text-text-3 hover:text-text-1")} aria-pressed={type === t.key}>
            <t.icon className="size-3.5" /> {t.label}
            {meta?.counts && t.key !== "all" && meta.counts[t.key] !== undefined ? <span className="num text-xs text-text-3">{meta.counts[t.key]}</span> : null}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1 pb-1" role="radiogroup" aria-label="Search mode">
          {MODES.map((m) => (
            <button key={m} role="radio" aria-checked={mode === m} onClick={() => set({ mode: m === "hybrid" ? null : m })} className={cn("h-7 rounded-control px-2 text-xs capitalize", mode === m ? "bg-bg-3 text-text-1" : "text-text-3 hover:text-text-1")}>
              {m}
            </button>
          ))}
        </div>
      </div>
      {meta?.effectiveMode && meta.effectiveMode !== mode ? <p className="mt-2 text-xs text-warning">Semantic search is warming up — showing keyword results.</p> : null}
      <div className="mt-4">
        {!q ? (
          <EmptyState icon={<SearchIcon />} title="Search the atlas" body="Hybrid search fuses keyword and semantic rankings (reciprocal rank fusion). Transcript hits link straight to the timestamp." />
        ) : r.isLoading ? (
          <div className="space-y-3">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-16 rounded-card" />)}</div>
        ) : r.error ? (
          <ErrorState error={r.error} onRetry={() => r.refetch()} />
        ) : !hits.length ? (
          <EmptyState icon={<SearchIcon />} title={`No results for “${q}”`} body="Try another mode, a broader query, or discover new channels on YouTube.">
            <Button asChild variant="secondary"><Link href={`/discover?q=${encodeURIComponent(q)}`}>Discover on YouTube</Link></Button>
          </EmptyState>
        ) : (
          <>
            <ul className="space-y-2" data-testid="search-results">
              {hits.map((h) => <Hit key={`${h.type}:${h.id}`} h={h} />)}
            </ul>
            {r.hasNextPage ? (
              <div className="mt-4 flex justify-center">
                <Button variant="secondary" onClick={() => r.fetchNextPage()} disabled={r.isFetchingNextPage}>{r.isFetchingNextPage ? "Loading…" : "Load more"}</Button>
              </div>
            ) : null}
            {meta?.ms !== undefined ? <p className="mt-3 text-right text-xs text-text-3">{meta.ms} ms · {meta.effectiveMode}</p> : null}
          </>
        )}
      </div>
    </Page>
  );
}

function SearchForm({ initial, onSubmit }: { initial: string; onSubmit: (q: string) => void }) {
  const [input, setInput] = useState(initial);
  return (
    <form onSubmit={(e) => (e.preventDefault(), onSubmit(input.trim()))} className="flex gap-2">
      <div className="relative flex-1">
        <SearchIcon className="absolute left-2.5 top-2.5 size-4 text-text-3" />
        <Input autoFocus value={input} onChange={(e) => setInput(e.target.value)} placeholder="Search channels, videos, transcripts, topics…" className="h-9 pl-8" aria-label="Search" data-testid="search-input" />
      </div>
      <Button type="submit" variant="primary" className="h-9">Search</Button>
    </form>
  );
}

function Hit({ h }: { h: SearchHit }) {
  const href = h.type === "channel" ? `/channels/${h.nodeId.slice(8)}` : h.type === "video" || h.type === "transcript" ? `/videos/${h.nodeId.slice(6)}` : `/atlas?mode=local&focus=${encodeURIComponent(h.nodeId)}&depth=2`;
  const isVideo = h.type === "video" || h.type === "transcript";
  return (
    <li className="flex gap-3 rounded-card border border-border bg-bg-1 p-3">
      {h.thumbnailUrl ? <img src={h.thumbnailUrl} alt="" className={cn("shrink-0 border border-border object-cover", isVideo ? "aspect-video w-32 rounded-[6px]" : "size-10 rounded-full")} /> : <div className="flex size-10 shrink-0 items-center justify-center rounded-full border border-border bg-bg-3 text-text-3"><Hash className="size-4" /></div>}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Badge>{h.type}</Badge>
          <Link href={href} className="truncate text-sm font-medium text-text-1 hover:text-accent-300">{h.title}</Link>
        </div>
        <div className="mt-0.5 text-xs text-text-3">
          {h.subtitle}
          {h.meta?.subscriberCount ? ` · ${fmtCompact(h.meta.subscriberCount as number)} subs` : ""}
          {h.meta?.viewCount !== undefined && h.meta?.viewCount !== null ? ` · ${fmtCompact(h.meta.viewCount as number)} views` : ""}
          {h.meta?.publishedAt ? ` · ${fmtRelative(h.meta.publishedAt as string)}` : ""}
        </div>
        {h.type !== "transcript" && h.snippet ? <Highlight text={h.snippet} className="mt-1 line-clamp-2 block text-[13px] text-text-2" /> : null}
        {h.chunks?.length ? (
          <ul className="mt-1.5 space-y-1">
            {h.chunks.map((c) => (
              <li key={c.chunkId} className="flex gap-2 text-[13px]">
                <Link href={`/videos/${h.nodeId.slice(6)}?t=${Math.floor(c.startSec)}`} className="num shrink-0 text-accent-300 hover:underline">{fmtTimestamp(c.startSec)}</Link>
                <Highlight text={c.text} className="line-clamp-2 text-text-2" />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <Link href={`/atlas?mode=local&focus=${encodeURIComponent(h.nodeId)}&depth=2`} aria-label="Show in atlas" className="self-start text-text-3 hover:text-text-1"><Network className="size-4" /></Link>
    </li>
  );
}
