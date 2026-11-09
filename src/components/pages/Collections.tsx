"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download, Folder, LayoutGrid, List, Network, Plus, Star, Trash2, X } from "lucide-react";
import { Page } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge, Dialog, DialogContent, EmptyState, ErrorState, Skeleton } from "@/components/ui/misc";
import { NoteEditor, PanelSkeleton } from "@/components/inspector/Inspector";
import { api } from "@/lib/api";
import { useActiveWorkspace, useCollections, useMe } from "@/lib/hooks";
import { fmtCompact, fmtRelative } from "@/lib/format";
import { nodeAppUrl } from "@/lib/atlas/graph";
import { cn } from "@/lib/cn";

const COLORS = ["#4361FF", "#57C7C2", "#E8B04B", "#F06A6A", "#3CCB8F", "#B58CFF", "#D9DCE3"];

function SignInGate() {
  return (
    <Page>
      <EmptyState icon={<Folder />} title="Sign in to use collections" body="Collections, notes, saved views and pinned layouts are private to your account.">
        <Button asChild variant="primary">
          <Link href="/signin?next=/collections">Sign in</Link>
        </Button>
      </EmptyState>
    </Page>
  );
}

export function CollectionsPage() {
  const me = useMe();
  const { workspace } = useActiveWorkspace();
  const cols = useCollections(workspace?.id);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState(COLORS[0]!);
  if (me.data === null) return <SignInGate />;
  return (
    <Page wide>
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-xl text-text-1">Collections</h1>
          <p className="mt-1 text-sm text-text-2">{workspace ? `In ${workspace.name}` : ""}</p>
        </div>
        <Button variant="primary" onClick={() => setOpen(true)} data-testid="create-collection">
          <Plus /> New collection
        </Button>
      </div>
      {cols.isLoading || me.isLoading ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-28 rounded-card" />)}</div>
      ) : cols.error ? (
        <ErrorState error={cols.error} onRetry={() => cols.refetch()} />
      ) : cols.data!.length ? (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {cols.data!.map((c) => (
            <li key={c.id}>
              <Link href={`/collections/${c.id}`} className="block rounded-card border border-border bg-bg-1 p-4 transition-colors hover:border-border-strong">
                <div className="flex items-center gap-2">
                  {c.icon === "star" ? <Star className="size-4" style={{ color: c.color }} /> : <Folder className="size-4" style={{ color: c.color }} />}
                  <span className="text-base text-text-1">{c.name}</span>
                  <span className="num ml-auto text-xs text-text-3">{c._count.items} items</span>
                </div>
                {c.description ? <p className="mt-2 line-clamp-2 text-sm text-text-2">{c.description}</p> : null}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState icon={<Folder />} title="No collections yet" body="Create one, then save channels, videos and topics into it from the atlas." />
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="New collection">
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!workspace) return;
              try {
                await api.post(`/api/workspaces/${workspace.id}/collections`, { name, color });
                await qc.invalidateQueries({ queryKey: ["collections", workspace.id] });
                setOpen(false);
                setName("");
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Could not create");
              }
            }}
          >
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" maxLength={80} required aria-label="Collection name" />
            <div className="flex gap-2" role="radiogroup" aria-label="Color">
              {COLORS.map((c) => (
                <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c} onClick={() => setColor(c)} className={cn("size-6 rounded-full border-2", color === c ? "border-text-1" : "border-transparent")} style={{ background: c }} />
              ))}
            </div>
            <div className="flex justify-end">
              <Button type="submit" variant="primary" disabled={!name.trim()}>
                Create
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </Page>
  );
}

interface CollectionDetail {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  color: string;
  items: { id: string; nodeId: string; note: string | null; tags: string[]; addedAt: string; node: { type: string; label: string; attrs: Record<string, unknown> } | null }[];
}

export function CollectionDetailPage({ id }: { id: string }) {
  const me = useMe();
  const q = useQuery({ queryKey: ["collection", id], queryFn: () => api.get<CollectionDetail>(`/api/collections/${id}`), enabled: Boolean(me.data) });
  const qc = useQueryClient();
  const router = useRouter();
  const [view, setView] = useState<"grid" | "list">("grid");
  const [tag, setTag] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  if (me.data === null) return <SignInGate />;
  if (q.isLoading || me.isLoading)
    return (
      <Page wide>
        <PanelSkeleton rows={6} />
      </Page>
    );
  if (q.error)
    return (
      <Page>
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </Page>
    );
  const c = q.data!;
  const tags = [...new Set(c.items.flatMap((i) => i.tags))].sort();
  const items = tag ? c.items.filter((i) => i.tags.includes(tag)) : c.items;
  const remove = async (nodeId: string) => {
    // Optimistic removal.
    qc.setQueryData<CollectionDetail>(["collection", id], (old) => old && { ...old, items: old.items.filter((i) => i.nodeId !== nodeId) });
    try {
      await api.del(`/api/collections/${id}/items`, { nodeIds: [nodeId] });
      void qc.invalidateQueries({ queryKey: ["collections", c.workspaceId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not remove");
      void qc.invalidateQueries({ queryKey: ["collection", id] });
    }
  };
  return (
    <Page wide>
      <div className="mb-6 flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <Link href="/collections" className="text-xs text-text-3 hover:text-text-1">
            ← Collections
          </Link>
          <h1 className="mt-1 flex items-center gap-2 text-xl text-text-1">
            <span className="size-3 rounded-full" style={{ background: c.color }} />
            {c.name}
          </h1>
          <p className="num mt-1 text-sm text-text-3">{c.items.length} items</p>
        </div>
        <Button variant="secondary" asChild>
          <Link href={`/atlas?collection=${c.id}`} data-testid="show-in-atlas">
            <Network /> Show in atlas
          </Link>
        </Button>
        <Button variant="ghost" asChild>
          <a href={`/api/collections/${c.id}/export?format=csv`}>
            <Download /> CSV
          </a>
        </Button>
        <Button variant="ghost" asChild>
          <a href={`/api/collections/${c.id}/export?format=json`}>
            <Download /> JSON
          </a>
        </Button>
        <div className="flex rounded-control border border-border">
          <button aria-label="Grid view" aria-pressed={view === "grid"} onClick={() => setView("grid")} className={cn("p-1.5 text-text-3", view === "grid" && "bg-bg-3 text-text-1")}>
            <LayoutGrid className="size-4" />
          </button>
          <button aria-label="List view" aria-pressed={view === "list"} onClick={() => setView("list")} className={cn("p-1.5 text-text-3", view === "list" && "bg-bg-3 text-text-1")}>
            <List className="size-4" />
          </button>
        </div>
        <Button
          variant="ghost"
          aria-label="Delete collection"
          onClick={async () => {
            if (!confirm(`Delete “${c.name}” and its ${c.items.length} items? This cannot be undone.`)) return;
            await api.del(`/api/collections/${c.id}`);
            await qc.invalidateQueries({ queryKey: ["collections", c.workspaceId] });
            router.push("/collections");
          }}
        >
          <Trash2 />
        </Button>
      </div>
      {tags.length ? (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {tags.map((t) => (
            <button key={t} onClick={() => setTag(tag === t ? null : t)}>
              <Badge tone={tag === t ? "accent" : "neutral"}>#{t}</Badge>
            </button>
          ))}
          {tag ? <button onClick={() => setTag(null)} className="text-xs text-text-3"><X className="inline size-3" /> clear</button> : null}
        </div>
      ) : null}
      {!items.length ? (
        <EmptyState icon={<Folder />} title="This collection is empty" body="Right-click a node in the atlas, or use Save in the inspector, to add items.">
          <Button asChild variant="primary">
            <Link href="/atlas">Open the atlas</Link>
          </Button>
        </EmptyState>
      ) : (
        <ul className={view === "grid" ? "grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" : "divide-y divide-border rounded-card border border-border"} data-testid="collection-items">
          {items.map((i) => {
            const a = i.node?.attrs ?? {};
            const thumb = (a.thumbnailUrl as string | undefined) ?? (i.nodeId.startsWith("video:") ? `/api/placeholder/thumb/${i.nodeId.slice(6)}` : undefined);
            return (
              <li key={i.id} className={view === "grid" ? "rounded-card border border-border bg-bg-1 p-3" : "flex items-start gap-3 p-3"}>
                <div className="flex items-start gap-3">
                  {thumb ? <img src={thumb} alt="" className={cn("shrink-0 border border-border object-cover", i.nodeId.startsWith("video:") ? "aspect-video w-24 rounded-[6px]" : "size-10 rounded-full")} /> : <div className="flex size-10 shrink-0 items-center justify-center rounded-full border border-border bg-bg-3 text-xs text-text-3">{(i.node?.type ?? "?").slice(0, 1)}</div>}
                  <div className="min-w-0 flex-1">
                    <Link href={nodeAppUrl(i.nodeId)} className="line-clamp-2 text-sm text-text-1 hover:text-accent-300">
                      {i.node?.label ?? i.nodeId}
                    </Link>
                    <div className="mt-0.5 text-xs text-text-3">
                      {(i.node?.type ?? "").toLowerCase()}
                      {a.subscriberCount ? ` · ${fmtCompact(a.subscriberCount as number)} subs` : ""} · added {fmtRelative(i.addedAt)}
                    </div>
                    {i.tags.length ? <div className="mt-1 flex flex-wrap gap-1">{i.tags.map((t) => <Badge key={t}>#{t}</Badge>)}</div> : null}
                    {i.note && editing !== i.id ? <p className="mt-2 whitespace-pre-line text-[13px] text-text-2">{i.note}</p> : null}
                  </div>
                  <button aria-label="Remove from collection" onClick={() => void remove(i.nodeId)} className="text-text-3 hover:text-danger">
                    <X className="size-4" />
                  </button>
                </div>
                {editing === i.id ? (
                  <div className="mt-3">
                    <NoteEditor collectionId={c.id} collectionName={c.name} item={i} onSaved={() => (setEditing(null), void qc.invalidateQueries({ queryKey: ["collection", id] }))} />
                  </div>
                ) : (
                  <button onClick={() => setEditing(i.id)} className="mt-2 text-xs text-text-3 hover:text-text-1">
                    {i.note ? "Edit note & tags" : "Add note & tags"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Page>
  );
}
