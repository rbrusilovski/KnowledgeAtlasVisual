"use client";

import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import {
  Copy, ExternalLink, EyeOff, FolderPlus, Globe2, Locate, Maximize2, Minus, Network, Pause, Pin, PinOff, Play, Plus, Sparkles, Table2, Waypoints, Database, Search as SearchIcon,
} from "lucide-react";
import { api } from "@/lib/api";
import { atlas } from "@/lib/atlas/controller";
import { atlasGraph, computeVisible, graphMeta, mergeSubgraph, nodeAppUrl, nodeYouTubeUrl, removeIds, type AtlasNodeAttrs } from "@/lib/atlas/graph";
import { useAtlasParams } from "@/lib/atlas/url";
import { useUi, type ColorBy, type LabelMode, type SizeBy } from "@/lib/atlas/store";
import { communityColor, nicheColor } from "@/lib/atlas/colors";
import { useActiveWorkspace, useAddToCollection, useCollections, useMe, useMembership, useQuota } from "@/lib/hooks";
import { useLive } from "@/lib/events";
import { Button } from "@/components/ui/button";
import { Badge, EmptyState, ErrorState, Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger, MenuSub, MenuSubContent, MenuSubTrigger, Skeleton, Tooltip, Slider } from "@/components/ui/misc";
import { fmtCompact, fmtRelative } from "@/lib/format";
import { cn } from "@/lib/cn";
import type { DeltaDTO, SubgraphDTO } from "@/shared/contracts/graph";

const TYPE_LABEL: Record<string, string> = { NICHE: "Niche", SUBNICHE: "Subniche", CHANNEL: "Channel", VIDEO: "Video", TOPIC: "Topic" };

// ── Data loading ────────────────────────────────────────────────────────────

function useLayoutPositions(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ["layout", workspaceId],
    queryFn: () => api.get<{ nodeId: string; x: number; y: number; pinned: boolean }[]>(`/api/workspaces/${workspaceId}/layout`),
    enabled: Boolean(workspaceId),
    staleTime: Infinity,
  });
}

/** Debounced batch save of dragged/pinned node positions to the workspace layout. */
function useLayoutSaver(workspaceId: string | undefined) {
  const pending = useRef(new Map<string, { nodeId: string; x: number; y: number; pinned: boolean }>());
  const removals = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(async () => {
    if (!workspaceId || (!pending.current.size && !removals.current.size)) return;
    const positions = [...pending.current.values()];
    const remove = [...removals.current];
    pending.current.clear();
    removals.current.clear();
    try {
      await api.put(`/api/workspaces/${workspaceId}/layout`, { positions, remove });
    } catch (e) {
      toast.error(e instanceof Error ? `Could not save layout: ${e.message}` : "Could not save layout");
    }
  }, [workspaceId]);
  const queue = useCallback(
    (nodeId: string, x: number, y: number, pinned = true) => {
      if (pinned) pending.current.set(nodeId, { nodeId, x, y, pinned });
      else {
        pending.current.delete(nodeId);
        removals.current.add(nodeId);
      }
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), 600);
    },
    [flush],
  );
  useEffect(() => () => void flush(), [flush]);
  return queue;
}

// ── Main view ───────────────────────────────────────────────────────────────

export function AtlasView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { params, setParams, filters } = useAtlasParams();
  const ui = useUi();
  const { workspace, signedIn } = useActiveWorkspace();
  const me = useMe();
  const layout = useLayoutPositions(workspace?.id);
  const membership = useMembership(filters.collection ? workspace?.id : undefined);
  const saveLayout = useLayoutSaver(workspace?.id);
  const live = useLive();
  const qc = useQueryClient();
  const [mounted, setMounted] = useState(false);
  const [version, setVersion] = useState(0); // bump when graph changes → recompute visibility
  const [cameraTick, setCameraTick] = useState(0);
  const reducedMotion = Boolean(me.data?.reducedMotion) || (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  const graphQuery = useQuery({
    queryKey: ["graph", params.mode, params.mode === "local" ? params.focus : null, params.mode === "local" ? params.depth : null],
    queryFn: () =>
      api.getWithMeta<SubgraphDTO>("/api/graph", params.mode === "local" && params.focus ? { mode: "local", focus: params.focus, depth: params.depth, limit: 2000 } : { mode: "global", limit: 2000, topics: 150 }).then((r) => r.data),
    staleTime: 30_000,
  });

  // Track pointer for drag-to-collection.
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const f = (e: MouseEvent) => (lastPointerRef.current = { x: e.clientX, y: e.clientY });
    window.addEventListener("mousemove", f);
    return () => window.removeEventListener("mousemove", f);
  }, []);
  const add = useAddToCollection();
  const cols = useCollections(workspace?.id);
  const dropToCollection = useEffectEvent((collectionId: string, ids: string[]) => {
    const name = cols.data?.find((c) => c.id === collectionId)?.name ?? "collection";
    add.mutate({ collectionId, workspaceId: workspace?.id, nodeIds: ids }, { onSuccess: (r) => toast.success(r.added ? `Saved to ${name}` : `Already in ${name}`) });
  });

  // Effect events always see the latest workspace/collections (the mount effect runs once).
  const onDragEnd = useEffectEvent((nodeId: string, x: number, y: number) => {
    saveLayout(nodeId, x, y, true);
    const pointer = lastPointerRef.current;
    const target = pointer && document.elementFromPoint(pointer.x, pointer.y)?.closest("[data-collection-drop]");
    const collectionId = target?.getAttribute("data-collection-drop");
    if (collectionId) dropToCollection(collectionId, [nodeId]);
  });

  // Mount sigma once.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let cancelled = false;
    void atlas
      .mount(el, {
        onSelect: (ids, mode) => useUi.getState().select(ids, mode),
        onHover: (h) => useUi.getState().set("hovered", h),
        onContextMenu: (m) => useUi.getState().set("contextMenu", m),
        onDragEnd: (nodeId, x, y) => onDragEnd(nodeId, x, y),
        onCamera: () => setCameraTick((t) => t + 1),
        onLayout: (running) => useUi.getState().set("layoutRunning", running),
        onExpand: (_id, added) => (added ? toast(`Expanded · ${added} new node${added === 1 ? "" : "s"}`) : toast("No new neighbors")),
        onError: (msg) => toast.error(msg),
      })
      .then(() => !cancelled && setMounted(true));
    const bump = () => setVersion((v) => v + 1);
    graphMeta.listeners.add(bump);
    return () => {
      cancelled = true;
      graphMeta.listeners.delete(bump);
      atlas.kill();
    };
     
  }, []);

  // Merge server subgraph (+ pinned layout) into the graphology instance.
  const loadedKey = useRef<string>("");
  useEffect(() => {
    if (!mounted || !graphQuery.data) return;
    // Wait for the session + workspace layout so pinned positions apply on the first merge.
    if (me.isPending || (signedIn && (!workspace || layout.isLoading))) return;
    const key = `${params.mode}|${params.focus}|${params.depth}|${graphQuery.dataUpdatedAt}`;
    if (loadedKey.current === key) return;
    const firstLoad = !loadedKey.current;
    loadedKey.current = key;
    const pinned = new Map((layout.data ?? []).map((p) => [p.nodeId, p]));
    const g = graphQuery.data;
    const added = mergeSubgraph(g.nodes, g.edges, { replace: true, pinned });
    graphMeta.version = g.version;
    useUi.getState().set("graphStats", { ...useUi.getState().graphStats, version: g.version, truncated: g.truncated });
    atlas.refresh();
    const needsLayout = added.length > 0 && added.some((id) => !pinned.has(id));
    if (needsLayout) void atlas.startLayout();
    if (params.mode === "local" && params.focus) setTimeout(() => atlas.flyTo(params.focus!, 0.7), firstLoad ? 900 : 300);
    else if (firstLoad || params.mode === "global") setTimeout(() => atlas.fit(), 200);
  }, [mounted, graphQuery.data, graphQuery.dataUpdatedAt, layout.data, layout.isLoading, signedIn, workspace, me.isPending, params.mode, params.focus, params.depth]);

  // Live updates: graph.delta → fetch delta since our version, merge with enter animation.
  useEffect(() => {
    return live.subscribe(async (ev) => {
      if (ev.type !== "graph.delta" || !atlas.sigma) return;
      try {
        const d = await api.get<DeltaDTO>("/api/graph/delta", { since: graphMeta.version });
        if (d.reset) {
          void qc.invalidateQueries({ queryKey: ["graph"] });
          return;
        }
        const mode = new URLSearchParams(window.location.search).get("mode") ?? "global";
        // Global view excludes videos; local view only accepts nodes adjacent to what's shown.
        const nodes = d.nodes.filter((n) => atlasGraph.hasNode(n.id) || (mode === "global" ? n.type !== "VIDEO" : d.edges.some((e) => (e.source === n.id && atlasGraph.hasNode(e.target)) || (e.target === n.id && atlasGraph.hasNode(e.source)))));
        removeIds(d.removedNodeIds, d.removedEdgeIds);
        const added = mergeSubgraph(nodes, d.edges);
        graphMeta.version = d.toVersion;
        atlas.refresh();
        if (added.length) {
          void atlas.startLayout(2_500);
          const ch = added.filter((id) => id.startsWith("channel:"));
          if (ch.length) toast(`${ch.length} channel${ch.length > 1 ? "s" : ""} appeared in the atlas`, { action: { label: "Show", onClick: () => (atlas.flyTo(ch[0]!), useUi.getState().select([ch[0]!])) } });
        }
      } catch {
        /* next delta will catch up */
      }
    });
  }, [live, qc]);

  // Visibility (filters) — recomputed only when inputs change, applied by reducers.
  const members = useMemo(() => (filters.collection && membership.data ? new Set(Object.entries(membership.data).filter(([, cols]) => cols.includes(filters.collection!)).map(([id]) => id)) : null), [filters.collection, membership.data]);
  const visible = useMemo(() => {
    void version;
    return computeVisible(filters, new Set(ui.hidden), members);
  }, [filters, ui.hidden, members, version]);

  useEffect(() => {
    atlas.setView({ colorBy: ui.colorBy, labels: ui.labels, sizeBy: ui.sizeBy, visible, selected: new Set(ui.selected), kinds: filters.kinds ? new Set(filters.kinds) : null, minWeight: filters.minWeight, reducedMotion });
    useUi.getState().set("graphStats", { ...useUi.getState().graphStats, nodes: atlasGraph.order, edges: atlasGraph.size, visible: visible.size });
  }, [ui.colorBy, ui.labels, ui.sizeBy, visible, ui.selected, filters.kinds, filters.minWeight, reducedMotion]);

  // Default-layout preference: with no explicit ?mode, "local" opens the last selected node's neighborhood.
  const appliedDefault = useRef(false);
  useEffect(() => {
    if (appliedDefault.current || !me.data) return;
    appliedDefault.current = true;
    if (new URLSearchParams(window.location.search).has("mode")) return;
    const last = useUi.getState().lastFocus;
    if (me.data.defaultLayout === "local" && last) void setParams({ mode: "local", focus: last, depth: 2 });
  }, [me.data, setParams]);

  // Search-to-focus from ⌘K or ?q deep link: fly to node, loading its neighborhood if absent.
  useEffect(() => {
    const onFocus = async (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (!atlas.flyTo(id)) {
        const n = await atlas.expand(id);
        if (!atlasGraph.hasNode(id) && !n) return void setParams({ mode: "local", focus: id, depth: 1 });
        setTimeout(() => atlas.flyTo(id), 500);
      }
      useUi.getState().select([id]);
    };
    window.addEventListener("atlas:focus", onFocus);
    return () => window.removeEventListener("atlas:focus", onFocus);
  }, [setParams]);

  // Keyboard shortcuts: [ ] toggle panels, F fit, L layout, Esc clear, Delete hide.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, [contenteditable=true], [role=dialog]")) return;
      if (e.key === "[") useUi.getState().toggleSidebar();
      else if (e.key === "]") useUi.getState().toggleInspector();
      else if (e.key === "f") atlas.fit();
      else if (e.key === "l") void (atlas.isLayoutRunning() ? atlas.stopLayout(true) : atlas.startLayout());
      else if (e.key === "Escape") useUi.getState().select([]);
      else if ((e.key === "Delete" || e.key === "Backspace") && useUi.getState().selected.length) useUi.getState().hide(useUi.getState().selected);
      else if (e.key === "+" || e.key === "=") atlas.zoom(1);
      else if (e.key === "-") atlas.zoom(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const empty = graphQuery.data && !graphQuery.data.nodes.some((n) => n.type === "CHANNEL") && params.mode === "global";

  return (
    <div className="relative flex min-w-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="canvas-bg absolute inset-0" data-testid="atlas-canvas" role="application" aria-label="Knowledge atlas graph. Use the list view for a keyboard-accessible table of nodes." />
        <ClusterLabels tick={cameraTick + version} visible={visible} colorBy={ui.colorBy} />
        {graphQuery.isLoading ? <LoadingOverlay /> : null}
        {graphQuery.error ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <ErrorState error={graphQuery.error} onRetry={() => graphQuery.refetch()} className="overlay rounded-panel" />
          </div>
        ) : null}
        {empty ? <EmptyAtlas /> : null}
        <ModeBar />
        <GraphControls />
        <HoverCard />
        <NodeContextMenu saveLayout={saveLayout} />
        <SelectionBar />
        {ui.listView ? <ListView visible={visible} /> : null}
      </div>
      <StatusBar />
    </div>
  );
}

// ── Overlays ────────────────────────────────────────────────────────────────

function LoadingOverlay() {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center" aria-busy="true">
      <div className="overlay flex items-center gap-3 rounded-card px-4 py-3 text-sm text-text-2">
        <span className="size-2 animate-ping rounded-full bg-accent-500" /> Loading atlas…
      </div>
    </div>
  );
}

function EmptyAtlas() {
  const { data: quota } = useQuota();
  const [loading, setLoading] = useState(false);
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="overlay max-w-md rounded-panel">
        <EmptyState icon={<Sparkles />} title="Your atlas is empty" body="Discover real channels on YouTube, or add one by URL. Each channel is ingested in the background and appears here live.">
          <Button asChild variant="primary">
            <Link href="/discover">Discover channels</Link>
          </Button>
          {quota?.mode === "fixture" ? (
            <Button
              variant="secondary"
              disabled={loading}
              onClick={async () => {
                setLoading(true);
                try {
                  const r = await api.post<{ queued: number }>("/api/demo/load");
                  toast.success(r.queued ? `Ingesting ${r.queued} fictional demo channels — they'll appear here live` : "The demo dataset is already loaded");
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Could not load the demo dataset");
                } finally {
                  setLoading(false);
                }
              }}
            >
              <Database /> {loading ? "Queuing…" : "Load demo dataset"}
            </Button>
          ) : null}
        </EmptyState>
      </div>
    </div>
  );
}

function ModeBar() {
  const { params, setParams } = useAtlasParams();
  const selected = useUi((s) => s.selected);
  const focusLabel = params.focus && atlasGraph.hasNode(params.focus) ? atlasGraph.getNodeAttribute(params.focus, "label") : params.focus;
  return (
    <div className="absolute left-3 top-3 flex items-center gap-2">
      <div className="overlay flex h-8 items-center rounded-card p-0.5 text-sm" role="radiogroup" aria-label="Graph mode">
        <button role="radio" aria-checked={params.mode === "global"} onClick={() => setParams({ mode: "global", focus: null })} className={cn("flex h-7 items-center gap-1.5 rounded-control px-2.5", params.mode === "global" ? "bg-bg-3 text-text-1" : "text-text-3 hover:text-text-1")}>
          <Globe2 className="size-3.5" /> Global
        </button>
        <button
          role="radio"
          aria-checked={params.mode === "local"}
          disabled={!params.focus && !selected[0]}
          onClick={() => setParams({ mode: "local", focus: params.focus ?? selected[0] ?? null })}
          className={cn("flex h-7 items-center gap-1.5 rounded-control px-2.5 disabled:opacity-40", params.mode === "local" ? "bg-bg-3 text-text-1" : "text-text-3 hover:text-text-1")}
        >
          <Waypoints className="size-3.5" /> Local
        </button>
      </div>
      {params.mode === "local" && params.focus ? (
        <div className="overlay flex h-8 items-center gap-3 rounded-card px-3 text-sm">
          <span className="max-w-56 truncate text-text-2">{focusLabel}</span>
          <span className="text-xs text-text-3">Depth</span>
          <Slider className="w-20" min={1} max={3} step={1} value={[params.depth]} onValueChange={([d]) => setParams({ depth: d ?? 2 })} aria-label="Neighborhood depth" />
          <span className="num w-3 text-xs text-text-2">{params.depth}</span>
        </div>
      ) : null}
    </div>
  );
}

function ControlButton({ label, onClick, children, active }: { label: string; onClick: () => void; children: React.ReactNode; active?: boolean }) {
  return (
    <Tooltip content={label} side="top">
      <button onClick={onClick} aria-label={label} aria-pressed={active} className={cn("flex size-8 items-center justify-center rounded-control text-text-2 hover:bg-bg-3 hover:text-text-1 [&_svg]:size-4 [&_svg]:stroke-[1.5]", active && "bg-accent-500/15 text-accent-300")}>
        {children}
      </button>
    </Tooltip>
  );
}

function GraphControls() {
  const ui = useUi();
  const { params, setParams } = useAtlasParams();
  const pick = <T extends string>(label: string, value: T, options: [T, string][], set: (v: T) => void) => (
    <Menu>
      <MenuTrigger asChild>
        <button className="flex h-8 items-center gap-1 rounded-control px-2 text-xs text-text-2 hover:bg-bg-3 hover:text-text-1" aria-label={`${label}: ${value}`}>
          <span className="text-text-3">{label}</span> {options.find(([v]) => v === value)?.[1]}
        </button>
      </MenuTrigger>
      <MenuContent side="top" align="start">
        <MenuLabel>{label}</MenuLabel>
        {options.map(([v, l]) => (
          <MenuItem key={v} onSelect={() => set(v)} className={v === value ? "text-text-1" : ""}>
            <span className={cn("size-1.5 rounded-full", v === value ? "bg-accent-500" : "bg-transparent")} /> {l}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
  return (
    <div className="absolute bottom-3 left-3 flex items-center gap-1" data-testid="graph-controls">
      <div className="overlay flex items-center rounded-card p-0.5">
        <ControlButton label="Zoom in (+)" onClick={() => atlas.zoom(1)}>
          <Plus />
        </ControlButton>
        <ControlButton label="Zoom out (−)" onClick={() => atlas.zoom(-1)}>
          <Minus />
        </ControlButton>
        <ControlButton label="Fit to screen (F)" onClick={() => atlas.fit()}>
          <Maximize2 />
        </ControlButton>
        <ControlButton label={ui.layoutRunning ? "Pause layout (L)" : "Run layout (L)"} onClick={() => void (ui.layoutRunning ? atlas.stopLayout(true) : atlas.startLayout())} active={ui.layoutRunning}>
          {ui.layoutRunning ? <Pause /> : <Play />}
        </ControlButton>
      </div>
      <div className="overlay flex items-center rounded-card p-0.5">
        {pick<ColorBy>("Color", ui.colorBy, [["type", "Type"], ["niche", "Niche"], ["community", "Community"]], (v) => ui.set("colorBy", v))}
        {pick<LabelMode>("Labels", ui.labels, [["auto", "Auto"], ["all", "All"], ["none", "None"]], (v) => ui.set("labels", v))}
        {pick<SizeBy>("Size", ui.sizeBy, [["subscribers", "Subscribers"], ["views", "Views"], ["degree", "Degree"]], (v) => ui.set("sizeBy", v))}
      </div>
      <div className="overlay flex items-center rounded-card p-0.5">
        <ControlButton label={params.mode === "global" ? "Switch to local graph" : "Switch to global graph"} onClick={() => (params.mode === "global" ? ui.selected[0] && setParams({ mode: "local", focus: ui.selected[0] }) : setParams({ mode: "global", focus: null }))} active={params.mode === "local"}>
          {params.mode === "global" ? <Waypoints /> : <Globe2 />}
        </ControlButton>
        <ControlButton label="List view" onClick={() => ui.set("listView", !ui.listView)} active={ui.listView}>
          <Table2 />
        </ControlButton>
      </div>
    </div>
  );
}

interface ChannelCard {
  title: string;
  thumbnailUrl: string | null;
  subscriberCount: number | null;
  handle: string | null;
  niches: { slug: string; name: string; confidence: number }[];
  latestVideos: { nodeId: string; thumbnailUrl: string | null; title: string }[];
}

function HoverCard() {
  const hovered = useUi((s) => s.hovered);
  const id = hovered?.nodeId;
  const isChannel = Boolean(id?.startsWith("channel:"));
  const q = useQuery({ queryKey: ["channel", id?.slice(8)], queryFn: () => api.get<ChannelCard>(`/api/channels/${id!.slice(8)}`), enabled: isChannel, staleTime: 60_000 });
  if (!hovered || !id || !atlasGraph.hasNode(id)) return null;
  const a = atlasGraph.getNodeAttributes(id) as AtlasNodeAttrs;
  const left = Math.min(hovered.x + 16, (typeof window !== "undefined" ? window.innerWidth : 1200) - 700);
  return (
    <AnimatePresence>
      <motion.div key={id} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.12 }} className="overlay pointer-events-none absolute z-20 w-72 rounded-card p-3" style={{ left, top: hovered.y + 12 }} role="tooltip">
        {isChannel ? (
          q.data ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2.5">
                <img src={q.data.thumbnailUrl ?? ""} alt="" className="size-9 rounded-full border border-border" />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-text-1">{q.data.title}</div>
                  <div className="num text-xs text-text-3">{fmtCompact(q.data.subscriberCount)} subscribers</div>
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                {q.data.niches.slice(0, 3).map((n) => (
                  <Badge key={n.slug} tone="accent">{n.name}</Badge>
                ))}
              </div>
              <div className="grid grid-cols-3 gap-1">
                {q.data.latestVideos.slice(0, 3).map((v) => (
                  <img key={v.nodeId} src={v.thumbnailUrl ?? ""} alt={v.title} className="aspect-video w-full rounded-[4px] border border-border object-cover" />
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <Skeleton className="h-9" />
              <Skeleton className="h-12" />
            </div>
          )
        ) : (
          <div>
            <div className="text-xs text-text-3">{TYPE_LABEL[a.kind]}</div>
            <div className="text-sm text-text-1">{a.label}</div>
            <div className="num mt-1 text-xs text-text-3">{atlasGraph.degree(id)} connections</div>
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  );
}

function NodeContextMenu({ saveLayout }: { saveLayout: (id: string, x: number, y: number, pinned?: boolean) => void }) {
  const menu = useUi((s) => s.contextMenu);
  const set = useUi((s) => s.set);
  const { setParams } = useAtlasParams();
  const { workspace, signedIn } = useActiveWorkspace();
  const cols = useCollections(workspace?.id);
  const add = useAddToCollection();
  if (!menu) return null;
  const id = menu.nodeId;
  if (!atlasGraph.hasNode(id)) return null;
  const a = atlasGraph.getNodeAttributes(id);
  const close = () => set("contextMenu", null);
  const yt = nodeYouTubeUrl(id);
  const expandKinds: [string, string[]][] = [
    ["All connections", []],
    ["Videos", ["PUBLISHED"]],
    ["Topics", ["CHANNEL_TOPIC", "MENTIONS", "NICHE_TOPIC", "TOPIC_RELATED"]],
    ["Related channels", ["SIMILAR", "CO_TOPIC", "FEATURED", "CO_DISCOVERED"]],
    ["Niches", ["IN_NICHE", "CONTAINS"]],
  ];
  return (
    <Menu open onOpenChange={(o) => !o && close()} modal={false}>
      <MenuTrigger asChild>
        <span className="fixed size-px" style={{ left: menu.x, top: menu.y }} />
      </MenuTrigger>
      <MenuContent align="start" sideOffset={2} data-testid="node-context-menu">
        <MenuLabel className="max-w-56 truncate">{a.label}</MenuLabel>
        <SubMenu label="Expand by edge kind" icon={<Network />}>
          {expandKinds.map(([label, k]) => (
            <MenuItem key={label} onSelect={() => void atlas.expand(id, k.length ? k : undefined)}>
              {label}
            </MenuItem>
          ))}
        </SubMenu>
        {atlas.isExpanded(id) ? <MenuItem onSelect={() => atlas.collapse(id, new Set(useUi.getState().selected))}><Minus /> Collapse</MenuItem> : null}
        <MenuItem onSelect={() => useUi.getState().hide([id])}>
          <EyeOff /> Hide
        </MenuItem>
        <MenuItem
          onSelect={() => {
            const pinned = !a.pinned;
            atlas.setPinned(id, pinned);
            saveLayout(id, a.x, a.y, pinned);
          }}
        >
          {a.pinned ? <PinOff /> : <Pin />} {a.pinned ? "Unpin" : "Pin"}
        </MenuItem>
        {signedIn ? (
          <SubMenu label="Add to collection" icon={<FolderPlus />}>
            {cols.data?.length ? null : <MenuItem disabled>No collections</MenuItem>}
            {cols.data?.map((c) => (
              <MenuItem key={c.id} onSelect={() => add.mutate({ collectionId: c.id, workspaceId: workspace?.id, nodeIds: [id] }, { onSuccess: (r) => toast.success(r.added ? `Saved to ${c.name}` : `Already in ${c.name}`) })}>
                <span className="size-2 rounded-full" style={{ background: c.color }} /> {c.name}
              </MenuItem>
            ))}
          </SubMenu>
        ) : null}
        <MenuItem onSelect={() => void setParams({ mode: "local", focus: id, depth: 2 })}>
          <Locate /> Focus in local graph
        </MenuItem>
        {id.startsWith("channel:") ? (
          <MenuItem onSelect={() => void atlas.expand(id, ["SIMILAR", "CO_TOPIC", "FEATURED", "CO_DISCOVERED"])}>
            <Sparkles /> Find similar
          </MenuItem>
        ) : id.startsWith("topic:") || id.startsWith("video:") ? (
          <MenuItem onSelect={() => window.dispatchEvent(new CustomEvent("atlas:palette", { detail: a.label }))}>
            <SearchIcon /> Search “{a.label.slice(0, 24)}”
          </MenuItem>
        ) : null}
        {yt ? (
          <MenuItem onSelect={() => window.open(yt, "_blank", "noopener,noreferrer")}>
            <ExternalLink /> Open on YouTube
          </MenuItem>
        ) : null}
        <MenuItem
          onSelect={() => {
            void navigator.clipboard.writeText(new URL(nodeAppUrl(id), window.location.origin).toString());
            toast.success("Link copied");
          }}
        >
          <Copy /> Copy link
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

function SubMenu({ label, icon, children }: { label: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <MenuSub>
      <MenuSubTrigger>
        {icon} {label}
      </MenuSubTrigger>
      <MenuSubContent>{children}</MenuSubContent>
    </MenuSub>
  );
}

function SelectionBar() {
  const selected = useUi((s) => s.selected);
  const select = useUi((s) => s.select);
  const hide = useUi((s) => s.hide);
  const { workspace, signedIn } = useActiveWorkspace();
  const cols = useCollections(workspace?.id);
  const add = useAddToCollection();
  if (selected.length < 2) return null;
  return (
    <div className="overlay absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-2 rounded-card px-3 py-1.5 text-sm" role="toolbar" aria-label="Bulk actions">
      <span className="num text-text-1">{selected.length}</span>
      <span className="text-text-3">selected</span>
      {signedIn ? (
        <Menu>
          <MenuTrigger asChild>
            <Button size="sm" variant="secondary">
              <FolderPlus /> Add to collection
            </Button>
          </MenuTrigger>
          <MenuContent>
            {cols.data?.map((c) => (
              <MenuItem key={c.id} onSelect={() => add.mutate({ collectionId: c.id, workspaceId: workspace?.id, nodeIds: selected }, { onSuccess: (r) => toast.success(`Added ${r.added} to ${c.name}`) })}>
                {c.name}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      ) : null}
      <Button size="sm" variant="ghost" onClick={() => selected.forEach((id) => void atlas.expand(id))}>
        <Network /> Expand all
      </Button>
      <Button size="sm" variant="ghost" onClick={() => hide(selected)}>
        <EyeOff /> Hide
      </Button>
      <Button size="sm" variant="ghost" onClick={() => select([])}>
        Clear
      </Button>
    </div>
  );
}

/** Community/niche labels at cluster centroids when zoomed out (HTML overlay). */
function ClusterLabels({ tick, visible, colorBy }: { tick: number; visible: Set<string>; colorBy: ColorBy }) {
  const [labels, setLabels] = useState<{ key: string; x: number; y: number; text: string; color: string }[]>([]);
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      if (!atlas.sigma || atlas.cameraRatio() < 1.15 || colorBy === "type") return setLabels([]);
      const groups = new Map<string, { xs: number; ys: number; n: number; text: string; color: string }>();
      atlasGraph.forEachNode((nid, a) => {
        if (a.kind !== "CHANNEL" && a.kind !== "TOPIC") return;
        if (!visible.has(nid)) return;
        let key: string | null = null;
        let text = "";
        let color = "";
        if (colorBy === "community" && a.communityId !== null) {
          key = `c${a.communityId}`;
          color = communityColor(a.communityId);
        } else if (colorBy === "niche" && a.kind === "CHANNEL") {
          const n = (a.data as { niches?: string[] }).niches?.[0];
          if (n) {
            key = `n:${n}`;
            color = nicheColor(n);
            text = atlasGraph.hasNode(`niche:${n}`) ? atlasGraph.getNodeAttribute(`niche:${n}`, "label") : n;
          }
        }
        if (!key) return;
        const g = groups.get(key) ?? { xs: 0, ys: 0, n: 0, text, color };
        const p = atlas.sigma!.graphToViewport({ x: a.x, y: a.y });
        g.xs += p.x;
        g.ys += p.y;
        g.n++;
        if (!g.text && a.kind === "CHANNEL" && colorBy === "community") g.text = a.label;
        groups.set(key, g);
      });
      setLabels(
        [...groups.entries()]
          .filter(([, g]) => g.n >= 3 || colorBy === "niche")
          .map(([key, g]) => ({ key, x: g.xs / g.n, y: g.ys / g.n, text: colorBy === "community" ? `${g.text} · ${g.n}` : g.text, color: g.color })),
      );
    });
    return () => cancelAnimationFrame(id);
  }, [tick, visible, colorBy]);
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      {labels.map((l) => (
        <div key={l.key} className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap text-[13px] font-semibold uppercase tracking-[0.08em] opacity-70" style={{ left: l.x, top: l.y, color: l.color, textShadow: "0 1px 8px #0A0B0D, 0 0 2px #0A0B0D" }}>
          {l.text}
        </div>
      ))}
    </div>
  );
}

/** Accessible table of visible nodes, synchronized with selection (a11y alternative to the canvas). */
function ListView({ visible }: { visible: Set<string> }) {
  const selected = useUi((s) => s.selected);
  const select = useUi((s) => s.select);
  const [sort, setSort] = useState<{ key: "label" | "kind" | "degree" | "subs"; dir: 1 | -1 }>({ key: "degree", dir: -1 });
  const rows = useMemo(() => {
    const out: { id: string; label: string; kind: string; degree: number; subs: number }[] = [];
    for (const id of visible) {
      if (!atlasGraph.hasNode(id)) continue;
      const a = atlasGraph.getNodeAttributes(id);
      out.push({ id, label: a.label, kind: a.kind, degree: atlasGraph.degree(id), subs: Number((a.data as { subscriberCount?: number }).subscriberCount ?? -1) });
    }
    return out.sort((x, y) => (x[sort.key] < y[sort.key] ? -sort.dir : x[sort.key] > y[sort.key] ? sort.dir : 0)).slice(0, 2000);
  }, [visible, sort]);
  const header = (key: typeof sort.key, label: string) => (
    <th scope="col" aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"} className="px-3 py-2 text-left font-medium">
      <button onClick={() => setSort((s) => ({ key, dir: s.key === key ? ((-s.dir) as 1 | -1) : -1 }))} className="hover:text-text-1">
        {label} {sort.key === key ? (sort.dir === 1 ? "↑" : "↓") : ""}
      </button>
    </th>
  );
  return (
    <div className="absolute inset-y-3 right-3 z-10 flex w-[min(560px,60%)] flex-col overflow-hidden rounded-panel border border-border bg-bg-1/95 backdrop-blur" data-testid="list-view">
      <div className="flex items-center justify-between border-b border-border px-3 py-2 text-sm">
        <span className="text-text-1">Visible nodes</span>
        <span className="num text-xs text-text-3" data-testid="list-count">{rows.length}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-[13px]">
          <caption className="sr-only">Nodes currently visible in the atlas</caption>
          <thead className="sticky top-0 bg-bg-1 text-xs text-text-3">
            <tr>
              {header("label", "Name")}
              {header("kind", "Type")}
              {header("subs", "Subscribers")}
              {header("degree", "Links")}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                tabIndex={0}
                aria-selected={selected.includes(r.id)}
                onClick={(e) => (select([r.id], e.shiftKey ? "toggle" : "replace"), atlas.flyTo(r.id))}
                onKeyDown={(e) => e.key === "Enter" && (select([r.id]), atlas.flyTo(r.id))}
                draggable
                onDragStart={(e) => e.dataTransfer.setData("application/x-atlas-node", selected.includes(r.id) ? selected.join(",") : r.id)}
                className={cn("cursor-pointer border-t border-border/60 text-text-2 hover:bg-bg-3 focus:bg-bg-3 focus:outline-none", selected.includes(r.id) && "bg-accent-500/10 text-text-1")}
              >
                <td className="max-w-64 truncate px-3 py-1.5">{r.label}</td>
                <td className="px-3 py-1.5 text-text-3">{TYPE_LABEL[r.kind]}</td>
                <td className="num px-3 py-1.5">{r.subs >= 0 ? fmtCompact(r.subs) : "—"}</td>
                <td className="num px-3 py-1.5">{r.degree}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusBar() {
  const stats = useUi((s) => s.graphStats);
  const { jobs } = useLive();
  const active = jobs.filter((j) => j.state === "active");
  const lastSync = useQuery({ queryKey: ["last-sync"], queryFn: () => api.get<{ lastSyncedAt: string | null }[]>("/api/channels", { sort: "synced", limit: 1 }).then((r) => r[0]?.lastSyncedAt ?? null), refetchInterval: 60_000 });
  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-border bg-bg-1 px-3 text-xs text-text-3" aria-label="Status">
      <div className="flex min-w-0 items-center gap-3" aria-live="polite">
        {active.length ? (
          active.slice(0, 3).map((j) => (
            <span key={j.jobId} className="flex items-center gap-1.5">
              <span className="size-1.5 animate-pulse rounded-full bg-accent-500" />
              <span className="max-w-40 truncate text-text-2">{j.title ?? j.jobId.replace(/^ingest-/, "")}</span>
              <span>{j.step}</span>
              <span className="num">{j.pct ?? 0}%</span>
            </span>
          ))
        ) : (
          <span>No running jobs</span>
        )}
        {jobs.filter((j) => j.state !== "active").slice(0, 2).map((j) => (
          <span key={j.jobId} className={j.state === "failed" ? "text-danger" : "text-success"}>
            {j.state === "failed" ? "Failed" : "Done"}: {j.title ?? j.jobId}
          </span>
        ))}
      </div>
      <div className="ml-auto flex items-center gap-4">
        {lastSync.data ? <span>Last sync {fmtRelative(lastSync.data)}</span> : null}
        <span className="num" data-testid="graph-counts">
          {stats.visible.toLocaleString()} / {stats.nodes.toLocaleString()} nodes · {stats.edges.toLocaleString()} edges
        </span>
        {stats.truncated ? <Badge tone="warning">truncated</Badge> : null}
        <span className="num">v{stats.version ?? "—"}</span>
      </div>
    </footer>
  );
}
