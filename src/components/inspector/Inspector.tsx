"use client";

import type { AddChannelResult } from "@/shared/contracts/jobs";
import type { ProposalDTO } from "@/shared/contracts/expansion";
import { reviewProposal } from "@/components/expansion/ProposalReview";
import { useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { toast } from "sonner";
import { ExternalLink, FolderPlus, Network, PanelRightClose, PanelRightOpen, RefreshCw, Search, Sparkles, Users } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Badge, EmptyState, ErrorState, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger, Tooltip, Menu, MenuContent, MenuItem, MenuTrigger, MenuLabel } from "@/components/ui/misc";
import { Highlight, Linkified } from "@/components/ui/highlight";
import { useUi } from "@/lib/atlas/store";
import { atlas } from "@/lib/atlas/controller";
import { atlasGraph, nodeAppUrl, nodeYouTubeUrl } from "@/lib/atlas/graph";
import { useActiveWorkspace, useAddToCollection, useCollections } from "@/lib/hooks";
import { fmtCompact, fmtDate, fmtDuration, fmtRelative } from "@/lib/format";
import { cn } from "@/lib/cn";
import type { RelatedCreator } from "@/shared/contracts/graph";
import type { SearchHit } from "@/shared/contracts/search";

// ── Shared bits ─────────────────────────────────────────────────────────────

export function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-control border border-border bg-bg-2 px-2.5 py-2">
      <div className="text-xs text-text-3">{label}</div>
      <div className="num mt-0.5 text-base text-text-1">{value}</div>
    </div>
  );
}

function ShowInAtlas({ nodeId, label = "Focus" }: { nodeId: string; label?: string }) {
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => {
        if (!atlas.flyTo(nodeId)) void atlas.expand(nodeId);
        useUi.getState().select([nodeId]);
      }}
    >
      <Network /> {label}
    </Button>
  );
}

export function AddToCollectionMenu({ nodeIds, trigger }: { nodeIds: string[]; trigger?: React.ReactNode }) {
  const { workspace, signedIn } = useActiveWorkspace();
  const { data } = useCollections(workspace?.id);
  const add = useAddToCollection();
  if (!signedIn) return null;
  return (
    <Menu>
      <MenuTrigger asChild>{trigger ?? <Button size="sm" variant="secondary"><FolderPlus /> Save</Button>}</MenuTrigger>
      <MenuContent align="end">
        <MenuLabel>Add {nodeIds.length > 1 ? `${nodeIds.length} nodes` : ""} to collection</MenuLabel>
        {data?.length ? null : <MenuItem disabled>No collections</MenuItem>}
        {data?.map((c) => (
          <MenuItem key={c.id} onSelect={() => add.mutate({ collectionId: c.id, workspaceId: workspace?.id, nodeIds }, { onSuccess: (r) => toast.success(r.added ? `Saved to ${c.name}` : `Already in ${c.name}`), onError: (e) => toast.error(e.message) })}>
            <span className="size-2 rounded-full" style={{ background: c.color }} /> {c.name}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

function Avatar({ src, alt, size = 40 }: { src?: string | null; alt: string; size?: number }) {
  return src ? <img src={src} alt={alt} width={size} height={size} className="shrink-0 rounded-full border border-border bg-bg-3 object-cover" style={{ width: size, height: size }} /> : <div className="shrink-0 rounded-full border border-border bg-bg-3" style={{ width: size, height: size }} />;
}

export function VideoRow({ v, onFocus }: { v: { nodeId: string; title: string; thumbnailUrl: string | null; meta?: Record<string, unknown>; snippet?: string | null }; onFocus?: boolean }) {
  const id = v.nodeId.slice(6);
  return (
    <div className="group flex gap-2.5 rounded-control p-1.5 hover:bg-bg-3" draggable onDragStart={(e) => e.dataTransfer.setData("application/x-atlas-node", v.nodeId)}>
      <img src={v.thumbnailUrl ?? `/api/placeholder/thumb/${id}`} alt="" className="aspect-video w-24 shrink-0 rounded-[6px] border border-border object-cover" loading="lazy" />
      <div className="min-w-0 flex-1">
        <Link href={`/videos/${id}`} className="line-clamp-2 text-[13px] leading-snug text-text-1 hover:text-accent-300">
          {v.title}
        </Link>
        <div className="num mt-0.5 text-xs text-text-3">
          {fmtCompact(Number(v.meta?.viewCount ?? 0))} views · {fmtRelative(String(v.meta?.publishedAt ?? ""))}
          {v.meta?.durationSec ? ` · ${fmtDuration(Number(v.meta.durationSec))}` : ""}
          {v.meta?.hasTranscript ? " · CC" : ""}
        </div>
        {v.snippet ? <Highlight text={v.snippet} className="mt-0.5 line-clamp-2 block text-xs text-text-2" /> : null}
      </div>
      {onFocus ? (
        <button aria-label="Show in atlas" className="self-start text-text-3 opacity-0 hover:text-text-1 group-hover:opacity-100" onClick={() => atlas.flyTo(v.nodeId) || void atlas.expand(v.nodeId.replace("video:", "video:"))}>
          <Network className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

// ── Channel ─────────────────────────────────────────────────────────────────

interface ChannelDetail {
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
  url: string;
  syncTier: string;
  lastSyncedAt: string | null;
  transcriptCount: number;
  niches: { slug: string; name: string; confidence: number; method: string; lowConfidence: boolean; rationale: string | null; parent: { slug: string; name: string } | null }[];
  topics: { nodeId: string; label: string; weight: number; videos: number }[];
  latestVideos: { nodeId: string; title: string; thumbnailUrl: string | null; publishedAt: string; viewCount: number | null; durationSec: number | null; hasTranscript: boolean }[];
  lastRun: { startedAt: string; unitsUsed: number } | null;
}

export function NicheChips({ niches }: { niches: ChannelDetail["niches"] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {niches.map((n) => (
        <Tooltip key={n.slug} content={<div><div>{n.parent?.name} › {n.name}</div><div className="text-text-3">{(n.confidence * 100).toFixed(0)}% · {n.method.toLowerCase()}{n.rationale ? ` — ${n.rationale}` : ""}</div></div>}>
          <span>
            <Badge tone={n.lowConfidence ? "warning" : "accent"}>
              {n.name} <span className="num opacity-70">{(n.confidence * 100).toFixed(0)}%</span>
            </Badge>
          </span>
        </Tooltip>
      ))}
    </div>
  );
}

function ChannelPanel({ nodeId }: { nodeId: string }) {
  const yt = nodeId.slice(8);
  const q = useQuery({ queryKey: ["channel", yt], queryFn: () => api.get<ChannelDetail>(`/api/channels/${yt}`) });
  const [vq, setVq] = useState("");
  const videos = useQuery({ queryKey: ["channel-videos", yt, vq], queryFn: () => api.get<SearchHit[]>(`/api/channels/${yt}/videos`, { q: vq || undefined, limit: 25 }) });
  const related = useQuery({ queryKey: ["related", yt], queryFn: () => api.get<RelatedCreator[]>(`/api/channels/${yt}/related`) });
  if (q.isLoading) return <PanelSkeleton />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const c = q.data!;
  return (
    <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-3 px-4 pb-3 pt-1">
        <div className="flex items-start gap-3">
          <Avatar src={c.thumbnailUrl} alt="" size={44} />
          <div className="min-w-0 flex-1">
            <Link href={`/channels/${c.youtubeId}`} className="block truncate text-md font-semibold text-text-1 hover:text-accent-300">
              {c.title}
            </Link>
            <div className="truncate text-xs text-text-3">{c.handle ? `@${c.handle}` : c.youtubeId}</div>
          </div>
        </div>
        <NicheChips niches={c.niches} />
        <div className="flex flex-wrap gap-1.5">
          <AddToCollectionMenu nodeIds={[nodeId]} />
          <ShowInAtlas nodeId={nodeId} />
          <Button size="sm" variant="ghost" asChild>
            <a href={c.url} target="_blank" rel="noopener noreferrer">
              <ExternalLink /> YouTube
            </a>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              try {
                reviewProposal(await api.post<ProposalDTO>(`/api/channels/${c.youtubeId}/sync`, {}));
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Sync failed");
              }
            }}
          >
            <RefreshCw /> Sync
          </Button>
        </div>
      </div>
      <TabsList>
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="videos">Videos</TabsTrigger>
        <TabsTrigger value="topics">Topics</TabsTrigger>
        <TabsTrigger value="related">Related</TabsTrigger>
        <TabsTrigger value="notes">Notes</TabsTrigger>
      </TabsList>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <TabsContent value="overview" className="space-y-4 p-4">
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Subscribers" value={fmtCompact(c.subscriberCount)} />
            <Stat label="Videos" value={fmtCompact(c.videoCount)} />
            <Stat label="Views" value={fmtCompact(c.viewCount)} />
          </div>
          <p className="whitespace-pre-line text-[13px] leading-relaxed text-text-2">
            <Linkified text={c.description.slice(0, 900)} />
          </p>
          <div className="text-xs text-text-3">
            Sync tier <span className="text-text-2">{c.syncTier.toLowerCase()}</span> · last synced {fmtRelative(c.lastSyncedAt)}
            {c.lastRun ? ` · ${c.lastRun.unitsUsed} units` : ""} · {c.transcriptCount} transcripts
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-text-3">Latest uploads</div>
            {c.latestVideos.slice(0, 4).map((v) => (
              <VideoRow key={v.nodeId} v={{ ...v, meta: { viewCount: v.viewCount, publishedAt: v.publishedAt, durationSec: v.durationSec, hasTranscript: v.hasTranscript } }} />
            ))}
          </div>
          <p className="text-[11px] text-text-3">Data from the YouTube Data API.</p>
        </TabsContent>
        <TabsContent value="videos" className="p-3">
          <div className="relative mb-2">
            <Search className="absolute left-2 top-2 size-4 text-text-3" />
            <Input placeholder="Search within channel…" value={vq} onChange={(e) => setVq(e.target.value)} className="pl-8" aria-label="Search within channel" />
          </div>
          {videos.isLoading ? <PanelSkeleton rows={4} /> : videos.error ? <ErrorState error={videos.error} onRetry={() => videos.refetch()} /> : videos.data!.length ? videos.data!.map((v) => <VideoRow key={v.id} v={v} onFocus />) : <EmptyState title="No matching videos" />}
          <Link href={`/channels/${c.youtubeId}`} className="mt-2 block text-center text-xs text-accent-300 hover:underline">
            All videos & filters →
          </Link>
        </TabsContent>
        <TabsContent value="topics" className="p-3">
          {c.topics.length ? (
            <ul className="space-y-0.5">
              {c.topics.map((t) => (
                <li key={t.nodeId} className="flex items-center gap-2 rounded-control px-2 py-1 hover:bg-bg-3">
                  <span className="size-1.5 rounded-full bg-node-topic" />
                  <button className="flex-1 text-left text-sm text-text-2 hover:text-text-1" onClick={() => useUi.getState().select([t.nodeId])}>
                    {t.label}
                  </button>
                  <div className="h-1 w-16 overflow-hidden rounded-full bg-bg-3">
                    <div className="h-full bg-node-topic/70" style={{ width: `${Math.min(100, t.weight * 100 / (c.topics[0]?.weight || 1))}%` }} />
                  </div>
                  <span className="num w-6 text-right text-xs text-text-3">{t.videos}</span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No topics yet" body="Topics appear once at least two videos share them." />
          )}
        </TabsContent>
        <TabsContent value="related" className="p-3">
          <RelatedList q={related} />
        </TabsContent>
        <TabsContent value="notes" className="p-3">
          <NotesPanel nodeId={nodeId} />
        </TabsContent>
      </div>
    </Tabs>
  );
}

export function RelatedList({ q }: { q: { isLoading: boolean; error: unknown; data?: RelatedCreator[]; refetch: () => unknown } }) {
  if (q.isLoading) return <PanelSkeleton rows={4} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data?.length) return <EmptyState icon={<Users />} title="No related creators yet" body="Relations are inferred from featured channels, shared topics, semantic similarity and co-discovery." />;
  return (
    <ul className="space-y-1">
      {q.data.map((r) => (
        <li key={r.nodeId} className="flex gap-2.5 rounded-control p-1.5 hover:bg-bg-3">
          <Avatar src={r.thumbnailUrl} alt="" size={32} />
          <div className="min-w-0 flex-1">
            {r.inAtlas ? (
              <button className="truncate text-left text-sm text-text-1 hover:text-accent-300" onClick={() => (atlas.flyTo(r.nodeId) || void atlas.expand(r.nodeId), useUi.getState().select([r.nodeId]))}>
                {r.title}
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <span className="num truncate text-sm text-text-2">{r.title}</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6"
                  onClick={async () => {
                    try {
                      const res = await api.post<AddChannelResult>("/api/channels", { input: r.youtubeId });
                      if (res.proposal) reviewProposal(res.proposal);
                      else toast.info("Already in the atlas");
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "Could not add");
                    }
                  }}
                >
                  Add
                </Button>
              </div>
            )}
            <ul className="mt-0.5 space-y-0.5">
              {r.reasons.slice(0, 3).map((reason, i) => (
                <li key={i} className="text-xs text-text-3">
                  {reason.text}
                </li>
              ))}
            </ul>
          </div>
          {r.subscriberCount !== null ? <span className="num text-xs text-text-3">{fmtCompact(r.subscriberCount)}</span> : null}
        </li>
      ))}
    </ul>
  );
}

interface CollectionWithItems {
  id: string;
  name: string;
  items: { id: string; nodeId: string; note: string | null; tags: string[] }[];
}

function NotesPanel({ nodeId }: { nodeId: string }) {
  const { workspace, signedIn } = useActiveWorkspace();
  const cols = useCollections(workspace?.id);
  const ids = cols.data?.map((c) => c.id) ?? [];
  const full = useQuery({ queryKey: ["collections-full", ids], queryFn: () => Promise.all(ids.map((id) => api.get<CollectionWithItems>(`/api/collections/${id}`))), enabled: ids.length > 0 });
  const qc = useQueryClient();
  if (!signedIn) return <EmptyState title="Sign in to take notes" />;
  if (cols.isLoading || full.isLoading) return <PanelSkeleton rows={2} />;
  const entries = (full.data ?? []).flatMap((c) => c.items.filter((i) => i.nodeId === nodeId).map((i) => ({ c, i })));
  if (!entries.length)
    return (
      <EmptyState title="Not in any collection" body="Save this node to a collection to attach notes and tags.">
        <AddToCollectionMenu nodeIds={[nodeId]} />
      </EmptyState>
    );
  return (
    <div className="space-y-4">
      {entries.map(({ c, i }) => (
        <NoteEditor key={i.id} collectionId={c.id} collectionName={c.name} item={i} onSaved={() => qc.invalidateQueries({ queryKey: ["collections-full"] })} />
      ))}
    </div>
  );
}

export function NoteEditor({ collectionId, collectionName, item, onSaved }: { collectionId: string; collectionName: string; item: { id: string; note: string | null; tags: string[] }; onSaved?: () => void }) {
  const [note, setNote] = useState(item.note ?? "");
  const [tags, setTags] = useState(item.tags.join(", "));
  const dirty = note !== (item.note ?? "") || tags !== item.tags.join(", ");
  return (
    <form
      className="space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api.patch(`/api/collections/${collectionId}/items/${item.id}`, { note: note || null, tags: tags.split(",").map((t) => t.trim()).filter(Boolean) });
          toast.success("Note saved");
          onSaved?.();
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Could not save");
        }
      }}
    >
      <div className="text-xs text-text-3">In {collectionName}</div>
      <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Write a note…" aria-label="Note" />
      <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Tags, comma separated" aria-label="Tags" />
      <div className="flex justify-end">
        <Button size="sm" variant="primary" type="submit" disabled={!dirty}>
          Save note
        </Button>
      </div>
    </form>
  );
}

// ── Other node types ────────────────────────────────────────────────────────

interface VideoDetail {
  youtubeId: string;
  nodeId: string;
  title: string;
  description: string;
  publishedAt: string;
  durationSec: number | null;
  viewCount: number | null;
  likeCount: number | null;
  url: string;
  thumbnailUrl: string | null;
  hasTranscript: boolean;
  channel: { nodeId: string; title: string; youtubeId: string };
  topics: { nodeId: string; label: string; weight: number; materialized: boolean }[];
}

function VideoPanel({ nodeId }: { nodeId: string }) {
  const id = nodeId.slice(6);
  const q = useQuery({ queryKey: ["video", id], queryFn: () => api.get<VideoDetail>(`/api/videos/${id}`) });
  if (q.isLoading) return <PanelSkeleton />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const v = q.data!;
  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
      <img src={v.thumbnailUrl ?? `/api/placeholder/thumb/${id}`} alt="" className="aspect-video w-full rounded-card border border-border object-cover" />
      <Link href={`/videos/${id}`} className="block text-md font-semibold leading-snug text-text-1 hover:text-accent-300">
        {v.title}
      </Link>
      <button className="text-sm text-text-2 hover:text-text-1" onClick={() => (atlas.flyTo(v.channel.nodeId) || void atlas.expand(v.channel.nodeId), useUi.getState().select([v.channel.nodeId]))}>
        {v.channel.title}
      </button>
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Views" value={fmtCompact(v.viewCount)} />
        <Stat label="Likes" value={fmtCompact(v.likeCount)} />
        <Stat label="Length" value={fmtDuration(v.durationSec)} />
      </div>
      <div className="text-xs text-text-3">Published {fmtDate(v.publishedAt)} {v.hasTranscript ? "· transcript available" : ""}</div>
      <div className="flex flex-wrap gap-1.5">
        <AddToCollectionMenu nodeIds={[nodeId]} />
        <Button size="sm" variant="ghost" asChild>
          <a href={v.url} target="_blank" rel="noopener noreferrer">
            <ExternalLink /> YouTube
          </a>
        </Button>
      </div>
      <div className="flex flex-wrap gap-1">
        {v.topics.filter((t) => t.materialized).map((t) => (
          <button key={t.nodeId} onClick={() => useUi.getState().select([t.nodeId])}>
            <Badge>{t.label}</Badge>
          </button>
        ))}
      </div>
      <p className="whitespace-pre-line text-[13px] leading-relaxed text-text-2">
        <Linkified text={v.description.slice(0, 1200)} />
      </p>
    </div>
  );
}

interface TopicDetail {
  label: string;
  aliases: string[];
  videoCount: number;
  channelCount: number;
  videos: { nodeId: string; title: string; thumbnailUrl: string | null; viewCount: number | null; publishedAt: string }[];
  channels: { nodeId: string; title: string; thumbnailUrl: string | null; videos: number }[];
}

function TopicPanel({ nodeId }: { nodeId: string }) {
  const slug = nodeId.slice(6);
  const q = useQuery({ queryKey: ["topic", slug], queryFn: () => api.get<TopicDetail>(`/api/topics/${encodeURIComponent(slug)}`) });
  if (q.isLoading) return <PanelSkeleton />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const t = q.data!;
  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
      <div>
        <Badge tone="neutral" className="mb-1">Topic</Badge>
        <h3 className="text-lg text-text-1">{t.label}</h3>
        {t.aliases.length > 1 ? <div className="text-xs text-text-3">Also: {t.aliases.filter((a) => a !== t.label).slice(0, 5).join(", ")}</div> : null}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Stat label="Videos" value={t.videoCount} />
        <Stat label="Channels" value={t.channelCount} />
      </div>
      <div className="flex gap-1.5">
        <AddToCollectionMenu nodeIds={[nodeId]} />
        <Button size="sm" variant="ghost" onClick={() => void atlas.expand(nodeId)}>
          <Network /> Expand
        </Button>
      </div>
      <div>
        <div className="mb-1 text-xs font-medium text-text-3">Channels</div>
        {t.channels.map((c) => (
          <button key={c.nodeId} className="flex w-full items-center gap-2 rounded-control p-1.5 text-left hover:bg-bg-3" onClick={() => (atlas.flyTo(c.nodeId) || void atlas.expand(c.nodeId), useUi.getState().select([c.nodeId]))}>
            <Avatar src={c.thumbnailUrl} alt="" size={24} />
            <span className="flex-1 truncate text-sm text-text-2">{c.title}</span>
            <span className="num text-xs text-text-3">{c.videos}</span>
          </button>
        ))}
      </div>
      <div>
        <div className="mb-1 text-xs font-medium text-text-3">Videos</div>
        {t.videos.slice(0, 12).map((v) => (
          <VideoRow key={v.nodeId} v={{ ...v, meta: { viewCount: v.viewCount, publishedAt: v.publishedAt } }} />
        ))}
      </div>
    </div>
  );
}

interface NicheDetail {
  name: string;
  description: string;
  depth: number;
  channelCount: number;
  keywords: string[];
  slug: string;
  channels: { nodeId: string; title: string; thumbnailUrl: string | null; subscriberCount: number | null }[];
  topics: { nodeId: string; label: string }[];
}

function NichePanel({ nodeId }: { nodeId: string }) {
  const slug = nodeId.slice(nodeId.indexOf(":") + 1);
  const q = useQuery({ queryKey: ["niche", slug], queryFn: () => api.get<NicheDetail>(`/api/niches/${slug}`) });
  if (q.isLoading) return <PanelSkeleton />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const n = q.data!;
  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
      <div>
        <Badge tone="accent" className="mb-1">{n.depth === 0 ? "Niche" : "Subniche"}</Badge>
        <h3 className="text-lg text-text-1">{n.name}</h3>
        <p className="mt-1 text-[13px] text-text-2">{n.description}</p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="secondary" asChild>
          <Link href={`/discover?niche=${n.slug}`}>
            <Sparkles /> Discover channels
          </Link>
        </Button>
        <Button size="sm" variant="ghost" asChild>
          <Link href={`/atlas?mode=local&focus=${encodeURIComponent(nodeId)}&depth=2`}>
            <Network /> Local graph
          </Link>
        </Button>
      </div>
      <div>
        <div className="mb-1 text-xs font-medium text-text-3">Top channels · {n.channelCount}</div>
        {n.channels.length ? n.channels.slice(0, 12).map((c) => (
          <button key={c.nodeId} className="flex w-full items-center gap-2 rounded-control p-1.5 text-left hover:bg-bg-3" onClick={() => (atlas.flyTo(c.nodeId), useUi.getState().select([c.nodeId]))}>
            <Avatar src={c.thumbnailUrl} alt="" size={24} />
            <span className="flex-1 truncate text-sm text-text-2">{c.title}</span>
            <span className="num text-xs text-text-3">{fmtCompact(c.subscriberCount)}</span>
          </button>
        )) : <p className="text-xs text-text-3">No channels yet — discover some.</p>}
      </div>
      <div className="flex flex-wrap gap-1">
        {n.topics.map((t) => (
          <button key={t.nodeId} onClick={() => useUi.getState().select([t.nodeId])}>
            <Badge>{t.label}</Badge>
          </button>
        ))}
      </div>
    </div>
  );
}

function MultiPanel({ ids }: { ids: string[] }) {
  const counts = ids.reduce<Record<string, number>>((a, id) => ((a[id.split(":")[0]!] = (a[id.split(":")[0]!] ?? 0) + 1), a), {});
  return (
    <div className="space-y-3 p-4">
      <h3 className="text-md text-text-1">{ids.length} selected</h3>
      <div className="flex flex-wrap gap-1">
        {Object.entries(counts).map(([k, n]) => (
          <Badge key={k}>{n} {k}{n > 1 ? "s" : ""}</Badge>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <AddToCollectionMenu nodeIds={ids} />
        <Button size="sm" variant="ghost" onClick={() => useUi.getState().hide(ids)}>Hide</Button>
        <Button size="sm" variant="ghost" onClick={() => ids.forEach((id) => atlas.setPinned(id, true))}>Pin</Button>
        <Button size="sm" variant="ghost" onClick={() => useUi.getState().select([])}>Clear</Button>
      </div>
      <ul className="max-h-[50vh] space-y-0.5 overflow-y-auto">
        {ids.map((id) => (
          <li key={id}>
            <button className="w-full truncate rounded-control px-2 py-1 text-left text-sm text-text-2 hover:bg-bg-3 hover:text-text-1" onClick={() => (atlas.flyTo(id), useUi.getState().select([id]))}>
              {atlasGraph.hasNode(id) ? atlasGraph.getNodeAttribute(id, "label") : id}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PanelSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-10 w-2/3" />
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-5" />)}
    </div>
  );
}

export function Inspector() {
  const open = useUi((s) => s.inspectorOpen);
  const toggle = useUi((s) => s.toggleInspector);
  const selected = useUi((s) => s.selected);
  const id = selected[0];
  const body =
    selected.length > 1 ? (
      <MultiPanel ids={selected} />
    ) : !id ? (
      <EmptyState icon={<Network />} title="Nothing selected" body="Click a node to inspect it. Double-click to expand, right-click for actions, shift-drag to box-select." />
    ) : id.startsWith("channel:") ? (
      <ChannelPanel key={id} nodeId={id} />
    ) : id.startsWith("video:") ? (
      <VideoPanel key={id} nodeId={id} />
    ) : id.startsWith("topic:") ? (
      <TopicPanel key={id} nodeId={id} />
    ) : (
      <NichePanel key={id} nodeId={id} />
    );
  return (
    <motion.aside initial={false} animate={{ width: open ? 380 : 44 }} transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }} className="relative z-10 flex shrink-0 flex-col overflow-hidden border-l border-border bg-bg-1" aria-label="Inspector" data-testid="inspector">
      <div className="flex h-10 shrink-0 items-center justify-between px-2.5">
        <Tooltip content={`${open ? "Collapse" : "Expand"} inspector ( ] )`} side="left">
          <button onClick={() => toggle()} className="rounded-control p-1 text-text-3 hover:bg-bg-3 hover:text-text-1" aria-label="Toggle inspector">
            {open ? <PanelRightClose className="size-4 stroke-[1.5]" /> : <PanelRightOpen className="size-4 stroke-[1.5]" />}
          </button>
        </Tooltip>
        {open && id ? (
          <div className="flex items-center gap-1">
            {nodeYouTubeUrl(id) ? null : null}
            <Link href={nodeAppUrl(id)} className="text-xs text-text-3 hover:text-text-1">
              Open page →
            </Link>
          </div>
        ) : null}
      </div>
      <div className={cn("flex min-h-0 w-[380px] flex-1 flex-col", !open && "invisible")}>{body}</div>
    </motion.aside>
  );
}
