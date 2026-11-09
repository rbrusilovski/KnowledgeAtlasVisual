"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Bookmark, ChevronRight, Compass, Eye, Filter, Folder, PanelLeftClose, PanelLeftOpen, Plus, Save, Star, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge, Checkbox, Dialog, DialogContent, Skeleton, Slider, Switch, Tooltip, EmptyState } from "@/components/ui/misc";
import { useActiveWorkspace, useAddToCollection, useCollections, useNiches, useViews, type NicheNode } from "@/lib/hooks";
import { useAtlasParams } from "@/lib/atlas/url";
import { useUi } from "@/lib/atlas/store";
import { nicheColor } from "@/lib/atlas/colors";
import { atlas } from "@/lib/atlas/controller";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { NODE_TYPES, EDGE_KINDS } from "@/shared/contracts/graph";

const TYPE_LABEL: Record<string, string> = { NICHE: "Niches", SUBNICHE: "Subniches", CHANNEL: "Channels", VIDEO: "Videos", TOPIC: "Topics" };
const KIND_LABEL: Record<string, string> = {
  CONTAINS: "Niche → subniche",
  IN_NICHE: "In niche",
  PUBLISHED: "Published",
  MENTIONS: "Mentions topic",
  CHANNEL_TOPIC: "Channel topic",
  FEATURED: "Featured",
  SIMILAR: "Semantic similarity",
  CO_TOPIC: "Shared topics",
  TOPIC_RELATED: "Related topics",
  NICHE_TOPIC: "Niche topic",
  CO_DISCOVERED: "Co-discovered",
};

function Section({ title, icon, children, action, defaultOpen = true }: { title: string; icon: React.ReactNode; children: React.ReactNode; action?: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-border py-2">
      <div className="flex items-center gap-1 px-3">
        <button onClick={() => setOpen(!open)} className="flex flex-1 items-center gap-1.5 py-1 text-xs font-medium uppercase tracking-wide text-text-3 hover:text-text-2" aria-expanded={open}>
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
          <span className="[&_svg]:size-3.5">{icon}</span>
          {title}
        </button>
        {action}
      </div>
      {open ? <div className="mt-1">{children}</div> : null}
    </section>
  );
}

function NicheTree() {
  const { data, isLoading, error, refetch } = useNiches();
  const { params, setParams } = useAtlasParams();
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  if (isLoading) return <div className="space-y-1.5 px-3">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-5" />)}</div>;
  if (error) return <div className="px-3 text-xs text-danger">Could not load niches. <button className="underline" onClick={() => refetch()}>Retry</button></div>;
  const focus = (n: NicheNode) => {
    if (!atlas.flyTo(n.nodeId, 0.6)) void setParams({ mode: "local", focus: n.nodeId, depth: 2 });
    useUi.getState().select([n.nodeId]);
  };
  return (
    <ul className="px-1.5" role="tree" aria-label="Niches">
      {data!.map((n) => (
        <li key={n.id} role="treeitem" aria-expanded={openIds.has(n.id)} aria-selected={params.focus === n.nodeId}>
          <div className={cn("group flex h-7 items-center gap-1 rounded-control pr-1 hover:bg-bg-3", params.focus === n.nodeId && "bg-bg-3")}>
            <button
              className="flex size-6 items-center justify-center text-text-3"
              aria-label={openIds.has(n.id) ? "Collapse" : "Expand"}
              onClick={() => setOpenIds((s) => {
                const x = new Set(s);
                if (x.has(n.id)) x.delete(n.id);
                else x.add(n.id);
                return x;
              })}
            >
              <ChevronRight className={cn("size-3.5 transition-transform", openIds.has(n.id) && "rotate-90")} />
            </button>
            <span className="size-2 shrink-0 rounded-full" style={{ background: nicheColor(n.slug) }} />
            <button className="flex-1 truncate text-left text-sm text-text-2 group-hover:text-text-1" onClick={() => focus(n)}>
              {n.name}
            </button>
            <span className="num text-xs text-text-3">{n.channelCount}</span>
          </div>
          {openIds.has(n.id) ? (
            <ul role="group">
              {n.children.map((c) => (
                <li key={c.id} role="treeitem" aria-selected={params.focus === c.nodeId}>
                  <button onClick={() => focus(c)} className={cn("flex h-6 w-full items-center gap-2 rounded-control pl-11 pr-2 text-left text-[13px] text-text-3 hover:bg-bg-3 hover:text-text-1", params.focus === c.nodeId && "bg-bg-3 text-text-1")}>
                    <span className="flex-1 truncate">{c.name}</span>
                    <span className="num text-xs">{c.channelCount}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function Collections() {
  const { workspace, signedIn, isLoading: sessionLoading } = useActiveWorkspace();
  const { data, isPending } = useCollections(workspace?.id);
  const { params, setParams } = useAtlasParams();
  const add = useAddToCollection();
  const qc = useQueryClient();
  const [over, setOver] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  if (sessionLoading) return <div className="space-y-1.5 px-3"><Skeleton className="h-6" /><Skeleton className="h-6" /></div>;
  if (!signedIn) return <p className="px-3 text-xs text-text-3"><Link href="/signin" className="text-accent-300 hover:underline">Sign in</Link> to save nodes into collections.</p>;
  if (isPending) return <div className="space-y-1.5 px-3"><Skeleton className="h-6" /><Skeleton className="h-6" /></div>;
  return (
    <div className="px-1.5">
      {data?.length ? null : <p className="px-2 pb-1 text-xs text-text-3">No collections yet.</p>}
      <ul>
        {data?.map((c) => (
          <li
            key={c.id}
            data-collection-drop={c.id}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes("application/x-atlas-node")) {
                e.preventDefault();
                setOver(c.id);
              }
            }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const ids = e.dataTransfer.getData("application/x-atlas-node").split(",").filter(Boolean);
              if (ids.length) add.mutate({ collectionId: c.id, workspaceId: workspace?.id, nodeIds: ids }, { onSuccess: (r) => toast.success(`Added ${r.added} to ${c.name}`) });
            }}
            className={cn("group flex h-7 items-center gap-2 rounded-control px-2 hover:bg-bg-3", over === c.id && "bg-accent-500/15 ring-1 ring-accent-500", params.collection === c.id && "bg-bg-3")}
          >
            {c.icon === "star" ? <Star className="size-3.5 stroke-[1.5]" style={{ color: c.color }} /> : <Folder className="size-3.5 stroke-[1.5]" style={{ color: c.color }} />}
            <Link href={`/collections/${c.id}`} className="flex-1 truncate text-sm text-text-2 hover:text-text-1">
              {c.name}
            </Link>
            <Tooltip content={params.collection === c.id ? "Clear filter" : "Show in atlas"}>
              <button aria-label={`Show ${c.name} in atlas`} onClick={() => setParams({ collection: params.collection === c.id ? null : c.id })} className="text-text-3 opacity-0 hover:text-text-1 group-hover:opacity-100">
                {params.collection === c.id ? <X className="size-3.5" /> : <Eye className="size-3.5" />}
              </button>
            </Tooltip>
            <span className="num text-xs text-text-3">{c._count.items}</span>
          </li>
        ))}
      </ul>
      {creating ? (
        <form
          className="flex gap-1 px-1 pt-1"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!workspace || !name.trim()) return;
            await api.post(`/api/workspaces/${workspace.id}/collections`, { name: name.trim() });
            await qc.invalidateQueries({ queryKey: ["collections", workspace.id] });
            setName("");
            setCreating(false);
          }}
        >
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Collection name" className="h-7" onBlur={() => !name && setCreating(false)} />
        </form>
      ) : (
        <button onClick={() => setCreating(true)} className="flex h-7 w-full items-center gap-2 rounded-control px-2 text-sm text-text-3 hover:bg-bg-3 hover:text-text-1" data-testid="new-collection">
          <Plus className="size-3.5" /> New collection
        </button>
      )}
    </div>
  );
}

function SavedViews({ onSave }: { onSave: () => void }) {
  const { workspace, signedIn } = useActiveWorkspace();
  const { data } = useViews(workspace?.id);
  const { setParams } = useAtlasParams();
  const ui = useUi();
  const qc = useQueryClient();
  if (!signedIn) return null;
  const apply = (state: Record<string, unknown>) => {
    const f = (state.filters ?? {}) as Record<string, unknown>;
    void setParams({
      mode: (state.mode as "global" | "local") ?? "global",
      focus: (state.focus as string) ?? null,
      depth: (state.depth as number) ?? 2,
      types: (f.types as never) ?? null,
      kinds: (f.kinds as never) ?? null,
      niches: (f.niches as string[]) ?? null,
      minSubs: (f.minSubs as number) ?? null,
      maxSubs: (f.maxSubs as number) ?? null,
      recency: (f.recency as number) ?? null,
      minWeight: (f.minWeight as number) ?? 0,
      transcript: Boolean(f.transcript),
      collection: (f.collection as string) ?? null,
    });
    if (state.colorBy) ui.set("colorBy", state.colorBy as never);
    if (state.sizeBy) ui.set("sizeBy", state.sizeBy as never);
    if (state.labels) ui.set("labels", state.labels as never);
    if (Array.isArray(state.hidden)) ui.set("hidden", state.hidden as string[]);
    const cam = state.camera as { x: number; y: number; ratio: number } | undefined;
    if (cam) setTimeout(() => void atlas.sigma?.getCamera().animate(cam, { duration: 400 }), 600);
  };
  return (
    <div className="px-1.5">
      {data?.length ? null : <p className="px-2 pb-1 text-xs text-text-3">Save the current filters, focus and camera.</p>}
      <ul>
        {data?.map((v) => (
          <li key={v.id} className="group flex h-7 items-center gap-2 rounded-control px-2 hover:bg-bg-3">
            <Bookmark className="size-3.5 stroke-[1.5] text-text-3" />
            <button onClick={() => apply(v.state)} className="flex-1 truncate text-left text-sm text-text-2 hover:text-text-1">
              {v.name}
            </button>
            <button
              aria-label={`Delete view ${v.name}`}
              className="text-text-3 opacity-0 hover:text-danger group-hover:opacity-100"
              onClick={async () => {
                await api.del(`/api/views/${v.id}`);
                await qc.invalidateQueries({ queryKey: ["views", workspace?.id] });
              }}
            >
              <Trash2 className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
      <button onClick={onSave} className="flex h-7 w-full items-center gap-2 rounded-control px-2 text-sm text-text-3 hover:bg-bg-3 hover:text-text-1">
        <Save className="size-3.5" /> Save current view
      </button>
    </div>
  );
}

function Filters() {
  const { params, setParams, activeFilterCount } = useAtlasParams();
  const types = params.types ?? [...NODE_TYPES];
  const kinds = params.kinds ?? [...EDGE_KINDS];
  const toggle = <T extends string>(list: T[], v: T, all: readonly T[]) => {
    const next = list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
    return next.length === all.length ? null : next;
  };
  const SUBS = [0, 1e3, 1e4, 1e5, 1e6, 1e7];
  const subsIdx = (v: number | null, d: number) => (v === null ? d : Math.max(0, SUBS.findIndex((s) => s >= v)));
  return (
    <div className="space-y-3 px-3 pb-1 text-sm">
      <fieldset>
        <legend className="mb-1 text-xs text-text-3">Node types</legend>
        <div className="grid grid-cols-2 gap-1">
          {NODE_TYPES.map((t) => (
            <label key={t} className="flex items-center gap-2 text-text-2">
              <Checkbox checked={types.includes(t)} onCheckedChange={() => setParams({ types: toggle(types, t, NODE_TYPES) as never })} aria-label={TYPE_LABEL[t]} />
              {TYPE_LABEL[t]}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-1 text-xs text-text-3">Edge kinds</legend>
        <div className="space-y-0.5">
          {EDGE_KINDS.map((k) => (
            <label key={k} className="flex items-center gap-2 text-[13px] text-text-2">
              <Checkbox checked={kinds.includes(k)} onCheckedChange={() => setParams({ kinds: toggle(kinds, k, EDGE_KINDS) as never })} aria-label={KIND_LABEL[k]} />
              {KIND_LABEL[k]}
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <div className="mb-1 flex justify-between text-xs text-text-3">
          <span>Subscribers</span>
          <span className="num">
            {params.minSubs ? Intl.NumberFormat("en", { notation: "compact" }).format(params.minSubs) : "0"} – {params.maxSubs ? Intl.NumberFormat("en", { notation: "compact" }).format(params.maxSubs) : "∞"}
          </span>
        </div>
        <Slider
          min={0}
          max={SUBS.length - 1}
          step={1}
          value={[subsIdx(params.minSubs, 0), subsIdx(params.maxSubs, SUBS.length - 1)]}
          onValueChange={([a, b]) => setParams({ minSubs: a ? SUBS[a!]! : null, maxSubs: b === SUBS.length - 1 ? null : SUBS[b!]! })}
          aria-label="Subscriber range"
        />
      </div>
      <div>
        <div className="mb-1 text-xs text-text-3">Upload recency</div>
        <div className="flex flex-wrap gap-1">
          {[null, 7, 30, 90, 365].map((d) => (
            <button key={String(d)} onClick={() => setParams({ recency: d })} className={cn("h-6 rounded-control border px-2 text-xs", params.recency === d ? "border-accent-500 bg-accent-500/15 text-accent-300" : "border-border text-text-2 hover:text-text-1")}>
              {d === null ? "Any" : d === 365 ? "1y" : `${d}d`}
            </button>
          ))}
        </div>
      </div>
      <div>
        <div className="mb-1 flex justify-between text-xs text-text-3">
          <span>Min edge weight</span>
          <span className="num">{params.minWeight.toFixed(2)}</span>
        </div>
        <Slider min={0} max={1} step={0.05} value={[params.minWeight]} onValueChange={([v]) => setParams({ minWeight: v || 0 })} aria-label="Minimum edge weight" />
      </div>
      <label className="flex items-center justify-between text-text-2">
        Has transcript
        <Switch checked={params.transcript} onCheckedChange={(v) => setParams({ transcript: v })} aria-label="Only nodes with transcripts" />
      </label>
      {activeFilterCount ? (
        <Button size="sm" variant="ghost" className="w-full" onClick={() => setParams({ types: null, kinds: null, niches: null, minSubs: null, maxSubs: null, recency: null, minWeight: 0, transcript: false, collection: null })}>
          <X /> Clear {activeFilterCount} filter{activeFilterCount > 1 ? "s" : ""}
        </Button>
      ) : null}
    </div>
  );
}

export function AtlasSidebar() {
  const open = useUi((s) => s.sidebarOpen);
  const toggle = useUi((s) => s.toggleSidebar);
  const { activeFilterCount } = useAtlasParams();
  const [saving, setSaving] = useState(false);
  const [viewName, setViewName] = useState("");
  const { workspace } = useActiveWorkspace();
  const { params } = useAtlasParams();
  const ui = useUi();
  const qc = useQueryClient();

  useEffect(() => {
    const f = () => setSaving(true);
    window.addEventListener("atlas:save-view", f);
    return () => window.removeEventListener("atlas:save-view", f);
  }, []);

  const saveView = async () => {
    if (!workspace) return;
    const cam = atlas.sigma?.getCamera().getState();
    await api.post(`/api/workspaces/${workspace.id}/views`, {
      name: viewName.trim() || "Untitled view",
      state: {
        mode: params.mode,
        focus: params.focus,
        depth: params.depth,
        filters: { types: params.types, kinds: params.kinds, niches: params.niches, minSubs: params.minSubs, maxSubs: params.maxSubs, recency: params.recency, minWeight: params.minWeight, transcript: params.transcript, collection: params.collection },
        colorBy: ui.colorBy,
        sizeBy: ui.sizeBy,
        labels: ui.labels,
        hidden: ui.hidden.slice(0, 2000),
        ...(cam ? { camera: { x: cam.x, y: cam.y, ratio: cam.ratio, angle: cam.angle } } : {}),
      },
    });
    await qc.invalidateQueries({ queryKey: ["views", workspace.id] });
    toast.success("View saved");
    setSaving(false);
    setViewName("");
  };

  return (
    <motion.aside
      initial={false}
      animate={{ width: open ? 280 : 56 }}
      transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
      className="relative z-10 flex shrink-0 flex-col overflow-hidden border-r border-border bg-bg-1"
      aria-label="Atlas sidebar"
    >
      <div className="flex h-10 shrink-0 items-center justify-between px-3">
        {open ? <span className="text-xs font-medium uppercase tracking-wide text-text-3">Explore</span> : null}
        <Tooltip content={`${open ? "Collapse" : "Expand"} sidebar ( [ )`} side="right">
          <button onClick={() => toggle()} className="rounded-control p-1 text-text-3 hover:bg-bg-3 hover:text-text-1" aria-label="Toggle sidebar">
            {open ? <PanelLeftClose className="size-4 stroke-[1.5]" /> : <PanelLeftOpen className="size-4 stroke-[1.5]" />}
          </button>
        </Tooltip>
      </div>
      {open ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Section title="Explore" icon={<Compass />}>
            <NicheTree />
          </Section>
          <Section title="Collections" icon={<Folder />}>
            <Collections />
          </Section>
          <Section title="Saved views" icon={<Bookmark />} defaultOpen={false}>
            <SavedViews onSave={() => setSaving(true)} />
          </Section>
          <Section title="Filters" icon={<Filter />} action={activeFilterCount ? <Badge tone="accent">{activeFilterCount}</Badge> : null}>
            <Filters />
          </Section>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-1 pt-1">
          {[
            [<Compass key="c" />, "Explore"],
            [<Folder key="f" />, "Collections"],
            [<Bookmark key="b" />, "Saved views"],
            [<Filter key="x" />, "Filters"],
          ].map(([icon, label]) => (
            <Tooltip key={label as string} content={label} side="right">
              <button onClick={() => toggle(true)} className="flex size-9 items-center justify-center rounded-control text-text-3 hover:bg-bg-3 hover:text-text-1 [&_svg]:size-4 [&_svg]:stroke-[1.5]" aria-label={label as string}>
                {icon}
              </button>
            </Tooltip>
          ))}
        </div>
      )}
      <Dialog open={saving} onOpenChange={setSaving}>
        <DialogContent title="Save view" description="Saves filters, focus, mode, colors and camera to this workspace.">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void saveView();
            }}
            className="space-y-3"
          >
            <Input autoFocus placeholder="View name" value={viewName} onChange={(e) => setViewName(e.target.value)} maxLength={80} />
            <div className="flex justify-end">
              <Button type="submit" variant="primary">
                Save
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </motion.aside>
  );
}

export { EmptyState };
