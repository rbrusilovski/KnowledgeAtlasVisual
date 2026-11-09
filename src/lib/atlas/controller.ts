"use client";

/**
 * Imperative bridge between React and sigma.js. Owns the Sigma instance, the ForceAtlas2 web-worker layout,
 * interaction handling (hover-highlight, select, box-select, drag-to-pin, expand) and view state used by the
 * node/edge reducers. React components call methods on the singleton `atlas`.
 */
import type Sigma from "sigma";
import type FA2Layout from "graphology-layout-forceatlas2/worker";
import { atlasGraph, mergeSubgraph, collapse as collapseGraph, type AtlasNodeAttrs, type AtlasEdgeAttrs } from "./graph";
import { TYPE_COLORS, EDGE_COLOR, EDGE_HIGHLIGHT, FADED_ALPHA, nicheColor, communityColor, withAlpha } from "./colors";
import type { ColorBy, LabelMode, SizeBy } from "./store";
import { api } from "@/lib/api";
import type { GraphEdgeDTO, GraphNodeDTO } from "@/shared/contracts/graph";

export interface ViewState {
  colorBy: ColorBy;
  labels: LabelMode;
  sizeBy: SizeBy;
  visible: Set<string> | null;
  selected: Set<string>;
  kinds: Set<string> | null;
  minWeight: number;
  reducedMotion: boolean;
}

export interface ControllerCallbacks {
  onSelect(ids: string[], mode: "replace" | "toggle" | "add"): void;
  onHover(h: { nodeId: string; x: number; y: number } | null): void;
  onContextMenu(m: { nodeId: string; x: number; y: number }): void;
  onDragEnd(nodeId: string, x: number, y: number): void;
  onCamera(): void;
  onLayout(running: boolean): void;
  onExpand(nodeId: string, added: number): void;
  onError(msg: string): void;
}

const ENTER_MS = 300;
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

class AtlasController {
  sigma: Sigma<AtlasNodeAttrs, AtlasEdgeAttrs> | null = null;
  private fa2: FA2Layout | null = null;
  private layoutTimer: ReturnType<typeof setTimeout> | null = null;
  private view: ViewState = { colorBy: "niche", labels: "auto", sizeBy: "subscribers", visible: null, selected: new Set(), kinds: null, minWeight: 0, reducedMotion: false };
  private hovered: string | null = null;
  private hoverNeighbors = new Set<string>();
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  private animating = false;
  private cb: ControllerCallbacks | null = null;
  private expanded = new Set<string>();
  private box: { x0: number; y0: number; el: HTMLDivElement } | null = null;
  private labelFont = "Inter, ui-sans-serif, system-ui, sans-serif";
  private dragging = false;
  private cleanup: (() => void)[] = [];
  private mountToken = 0;

  async mount(container: HTMLElement, cb: ControllerCallbacks) {
    this.cb = cb;
    const token = ++this.mountToken;
    const [{ default: SigmaCtor }, { layerFill }, { layerImage }] = await Promise.all([import("sigma"), import("sigma/rendering"), import("@sigma/node-image")]);
    // React StrictMode mounts twice; only the latest mount may create the renderer.
    if (token !== this.mountToken || !container.isConnected || this.sigma) return;
    this.labelFont = getComputedStyle(document.body).fontFamily || this.labelFont;
    const sigma = new SigmaCtor<AtlasNodeAttrs, AtlasEdgeAttrs>(atlasGraph, container, {
      primitives: {
        nodes: {
          layers: [
            layerFill(),
            layerImage({ imageAttribute: "image", drawingMode: "image" }),
          ],
        },
      },
      settings: {
        enableNodeDrag: true,
        allowInvalidContainer: true,
        // Clicking/hovering a label behaves exactly like the node itself.
        nodeLabelEvents: "extend",
        labelDensity: 0.9,
        labelGridCellSize: 90,
        labelRenderedSizeThreshold: 9,
        hideEdgesOnMove: false,
        minCameraRatio: 0.02,
        maxCameraRatio: 8,
        stagePadding: 40,
        doubleClickZoomingRatio: 1,
        itemSizesReference: "screen",
        zoomToSizeRatioFunction: (r: number) => Math.sqrt(r),
      } as never,
      nodeReducer: (key, _data, attrs) => this.nodeReducer(key, attrs),
      edgeReducer: (key, _data, attrs) => this.edgeReducer(key, attrs),
    });
    this.sigma = sigma;
    this.bindEvents(sigma, container);
    const ro = new ResizeObserver(() => sigma.resize());
    ro.observe(container);
    this.cleanup.push(() => ro.disconnect());
    if (atlasGraph.order) this.fit(false);
  }

  kill() {
    this.mountToken++;
    void this.stopLayout();
    this.fa2?.kill();
    this.fa2 = null;
    for (const c of this.cleanup) c();
    this.cleanup = [];
    this.sigma?.kill();
    this.sigma = null;
  }

  // ── Reducers ────────────────────────────────────────────────────────────

  private baseColor(a: AtlasNodeAttrs): string {
    if (a.kind === "NICHE" || a.kind === "SUBNICHE" || this.view.colorBy === "type") return TYPE_COLORS[a.kind]!;
    if (this.view.colorBy === "community") return a.kind === "VIDEO" ? TYPE_COLORS.VIDEO! : communityColor(a.communityId);
    // colorBy niche
    const d = a.data as { niches?: string[]; channel?: string };
    if (a.kind === "CHANNEL") return nicheColor(d.niches?.[0]);
    if (a.kind === "VIDEO" && d.channel && atlasGraph.hasNode(`channel:${d.channel}`)) {
      return withAlpha(nicheColor((atlasGraph.getNodeAttribute(`channel:${d.channel}`, "data") as { niches?: string[] }).niches?.[0]), 0.75);
    }
    return TYPE_COLORS[a.kind]!;
  }

  /** Server sizes are relative; scale per type for a calm, Obsidian-like hierarchy on screen. */
  private static TYPE_SCALE: Record<string, number> = { NICHE: 0.42, SUBNICHE: 0.45, CHANNEL: 0.95, TOPIC: 0.5, VIDEO: 0.75 };

  private baseSize(key: string, a: AtlasNodeAttrs): number {
    const scale = AtlasController.TYPE_SCALE[a.kind] ?? 1;
    if (a.kind !== "CHANNEL" || this.view.sizeBy === "subscribers") return a.size * scale;
    if (this.view.sizeBy === "views") {
      const v = Number((a.data as { viewCount?: number }).viewCount ?? 0);
      return 3 + Math.max(0, Math.log10(Math.max(v, 1)) - 3) * 2.6;
    }
    return 3 + Math.sqrt(atlasGraph.degree(key)) * 1.6;
  }

  private nodeReducer(key: string, a: AtlasNodeAttrs) {
    const v = this.view;
    if (v.visible && !v.visible.has(key)) return { visibility: "hidden" as const };
    let size = this.baseSize(key, a);
    let opacity = 1;
    if (a.enterAt !== undefined) {
      const t = (performance.now() - a.enterAt) / ENTER_MS;
      if (t < 1 && !v.reducedMotion) {
        size *= easeOut(Math.max(0.05, t));
        opacity = Math.max(0.05, t);
      }
    }
    const res: Record<string, unknown> = {
      color: this.baseColor(a),
      size,
      opacity,
      label: a.label,
      labelColor: "#C9CDD6",
      labelSize: a.kind === "NICHE" ? 15 : a.kind === "SUBNICHE" ? 13 : 12,
      labelFont: a.kind === "NICHE" || a.kind === "SUBNICHE" ? `600 ${this.labelFont}` : this.labelFont,
      labelVisibility: v.labels === "all" ? "visible" : v.labels === "none" ? "hidden" : a.kind === "NICHE" ? "visible" : "auto",
      backdropVisibility: "hidden",
      depth: "nodes",
      zIndex: a.kind === "NICHE" ? 3 : a.kind === "SUBNICHE" ? 2 : a.kind === "CHANNEL" ? 1 : 0,
    };
    const isSel = v.selected.has(key);
    if (this.hovered) {
      if (key === this.hovered || this.hoverNeighbors.has(key)) {
        res.depth = "topNodes";
        res.zIndex = 10;
        if (v.labels !== "none") res.labelVisibility = "visible";
      } else if (!isSel) {
        res.opacity = opacity * FADED_ALPHA;
        res.labelVisibility = "hidden";
      }
    }
    if (key === this.hovered || isSel) {
      res.backdropVisibility = "visible";
      res.backdropColor = isSel ? "rgba(67,97,255,0.22)" : "rgba(21,24,29,0.92)";
      res.backdropShadowColor = isSel ? "rgba(67,97,255,0.55)" : "rgba(0,0,0,0.5)";
      res.backdropShadowBlur = isSel ? 18 : 10;
      res.backdropBorderColor = isSel ? "#4361FF" : "#2F3440";
      res.backdropBorderWidth = 1;
      res.backdropPadding = 4;
      res.backdropCornerRadius = 8;
      res.depth = "topNodes";
      res.zIndex = 20;
      if (v.labels !== "none") res.labelVisibility = "visible";
    }
    if (a.pinned) res.backdropBorderColor = "#E8B04B";
    return res;
  }

  private edgeReducer(key: string, a: AtlasEdgeAttrs) {
    const v = this.view;
    const [s, t] = atlasGraph.extremities(key);
    if (v.visible && (!v.visible.has(s) || !v.visible.has(t))) return { visibility: "hidden" as const };
    if (v.kinds && !v.kinds.has(a.kind)) return { visibility: "hidden" as const };
    if (a.weight < v.minWeight) return { visibility: "hidden" as const };
    const res: Record<string, unknown> = { color: EDGE_COLOR, size: a.size, opacity: 1, depth: "edges" };
    if (this.hovered) {
      if (s === this.hovered || t === this.hovered) {
        res.color = EDGE_HIGHLIGHT;
        res.size = a.size + 0.8;
        res.depth = "topEdges";
      } else res.opacity = 0.25;
    } else if (v.selected.size && (v.selected.has(s) || v.selected.has(t))) {
      res.color = "rgba(106,130,255,0.35)";
      res.depth = "topEdges";
    }
    return res;
  }

  // ── View updates ────────────────────────────────────────────────────────

  setView(patch: Partial<ViewState>) {
    this.view = { ...this.view, ...patch };
    this.sigma?.refresh({ skipIndexation: true });
  }

  refresh() {
    this.sigma?.refresh();
    this.kickAnimation();
  }

  /** Run a frame loop while nodes are animating in. */
  private kickAnimation() {
    if (this.animating || !this.sigma || this.view.reducedMotion) return;
    this.animating = true;
    const loop = () => {
      if (!this.sigma) return void (this.animating = false);
      const now = performance.now();
      let any = false;
      atlasGraph.forEachNode((id, a) => {
        if (a.enterAt === undefined) return;
        if (now - a.enterAt < ENTER_MS) any = true;
        else atlasGraph.removeNodeAttribute(id, "enterAt");
      });
      this.sigma.refresh({ skipIndexation: true });
      if (any) requestAnimationFrame(loop);
      else this.animating = false;
    };
    requestAnimationFrame(loop);
  }

  // ── Events ──────────────────────────────────────────────────────────────

  private bindEvents(sigma: Sigma<AtlasNodeAttrs, AtlasEdgeAttrs>, container: HTMLElement) {
    const cb = this.cb!;
    sigma.on("enterNode", ({ node, event }) => {
      if (this.dragging) return;
      this.hovered = node;
      this.hoverNeighbors = new Set(atlasGraph.neighbors(node));
      sigma.refresh({ skipIndexation: true });
      container.style.cursor = "pointer";
      if (this.hoverTimer) clearTimeout(this.hoverTimer);
      const { x, y } = event;
      this.hoverTimer = setTimeout(() => cb.onHover({ nodeId: node, x, y }), 300);
    });
    sigma.on("leaveNode", () => {
      this.hovered = null;
      this.hoverNeighbors.clear();
      sigma.refresh({ skipIndexation: true });
      container.style.cursor = "";
      if (this.hoverTimer) clearTimeout(this.hoverTimer);
      cb.onHover(null);
    });
    sigma.on("clickNode", ({ node, event }) => {
      const o = event.original as MouseEvent;
      cb.onSelect([node], o.shiftKey || o.metaKey || o.ctrlKey ? "toggle" : "replace");
    });
    sigma.on("doubleClickNode", ({ node, event, preventSigmaDefault }) => {
      preventSigmaDefault();
      event.preventSigmaDefault();
      void this.toggleExpand(node);
    });
    sigma.on("rightClickNode", ({ node, event, preventSigmaDefault }) => {
      preventSigmaDefault();
      const rect = container.getBoundingClientRect();
      cb.onContextMenu({ nodeId: node, x: rect.left + event.x, y: rect.top + event.y });
    });
    sigma.on("clickStage", ({ event }) => {
      const o = event.original as MouseEvent;
      if (!o.shiftKey) cb.onSelect([], "replace");
    });
    sigma.on("nodeDragStart", ({ node }) => {
      this.dragging = true;
      atlasGraph.setNodeAttribute(node, "fixed", true);
      cb.onHover(null);
    });
    sigma.on("nodeDragEnd", ({ node }) => {
      this.dragging = false;
      const a = atlasGraph.getNodeAttributes(node);
      atlasGraph.mergeNodeAttributes(node, { fixed: true, pinned: true });
      cb.onDragEnd(node, a.x, a.y);
      sigma.refresh({ skipIndexation: true });
    });
    sigma.getCamera().on("updated", () => cb.onCamera());

    // Box select: shift + drag on the stage.
    sigma.on("downStage", ({ event, preventSigmaDefault }) => {
      const o = event.original as MouseEvent;
      if (!o.shiftKey) return;
      preventSigmaDefault();
      const el = document.createElement("div");
      el.className = "pointer-events-none absolute z-10 rounded-[4px] border border-accent-400 bg-accent-500/10";
      container.appendChild(el);
      this.box = { x0: event.x, y0: event.y, el };
      sigma.getCamera().enabledPanning = false;
    });
    const onMove = (e: MouseEvent) => {
      if (!this.box) return;
      const r = container.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      Object.assign(this.box.el.style, { left: `${Math.min(x, this.box.x0)}px`, top: `${Math.min(y, this.box.y0)}px`, width: `${Math.abs(x - this.box.x0)}px`, height: `${Math.abs(y - this.box.y0)}px` });
    };
    const onUp = (e: MouseEvent) => {
      if (!this.box) return;
      const r = container.getBoundingClientRect();
      const x1 = Math.min(e.clientX - r.left, this.box.x0);
      const x2 = Math.max(e.clientX - r.left, this.box.x0);
      const y1 = Math.min(e.clientY - r.top, this.box.y0);
      const y2 = Math.max(e.clientY - r.top, this.box.y0);
      this.box.el.remove();
      this.box = null;
      sigma.getCamera().enabledPanning = true;
      if (x2 - x1 < 4 && y2 - y1 < 4) return;
      const ids: string[] = [];
      atlasGraph.forEachNode((id, a) => {
        if (this.view.visible && !this.view.visible.has(id)) return;
        const p = sigma.graphToViewport({ x: a.x, y: a.y });
        if (p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2) ids.push(id);
      });
      cb.onSelect(ids, "add");
    };
    const noCtx = (e: Event) => e.preventDefault();
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    container.addEventListener("contextmenu", noCtx);
    this.cleanup.push(() => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      container.removeEventListener("contextmenu", noCtx);
    });
  }

  // ── Layout (ForceAtlas2 in a web worker) ────────────────────────────────

  async startLayout(durationMs?: number) {
    if (!atlasGraph.order) return;
    const [{ default: FA2 }, { inferSettings }] = await Promise.all([import("graphology-layout-forceatlas2/worker"), import("graphology-layout-forceatlas2")]);
    this.fa2?.kill();
    const settings = inferSettings(atlasGraph);
    this.fa2 = new FA2(atlasGraph, {
      settings: { ...settings, linLogMode: true, outboundAttractionDistribution: true, barnesHutOptimize: atlasGraph.order > 800, gravity: 0.8, scalingRatio: 12, slowDown: 4, adjustSizes: false, edgeWeightInfluence: 0.8 },
      getEdgeWeight: "weight",
    });
    this.fa2.start();
    this.cb?.onLayout(true);
    if (this.layoutTimer) clearTimeout(this.layoutTimer);
    // Auto-stop on (approximate) convergence: duration scales with graph size.
    const ms = durationMs ?? Math.min(9_000, 1_800 + atlasGraph.order * 1.6);
    this.layoutTimer = setTimeout(() => void this.stopLayout(true), ms);
  }

  async stopLayout(settle = false) {
    if (this.layoutTimer) clearTimeout(this.layoutTimer);
    this.layoutTimer = null;
    if (this.fa2?.isRunning()) this.fa2.stop();
    this.cb?.onLayout(false);
    if (settle && atlasGraph.order < 6_000) {
      const { default: noverlap } = await import("graphology-layout-noverlap");
      const fixed = new Map<string, { x: number; y: number }>();
      atlasGraph.forEachNode((id, a) => a.fixed && fixed.set(id, { x: a.x, y: a.y }));
      noverlap.assign(atlasGraph, { maxIterations: 40, settings: { ratio: 1.15, margin: 2 } });
      for (const [id, p] of fixed) atlasGraph.mergeNodeAttributes(id, p);
      this.sigma?.refresh();
    }
  }

  isLayoutRunning() {
    return Boolean(this.fa2?.isRunning());
  }

  // ── Camera ──────────────────────────────────────────────────────────────

  zoom(dir: 1 | -1) {
    const cam = this.sigma?.getCamera();
    if (!cam) return;
    void (dir > 0 ? cam.zoomIn({ duration: this.view.reducedMotion ? 0 : 240, factor: 1.6 }) : cam.zoomOut({ duration: this.view.reducedMotion ? 0 : 240, factor: 1.6 }));
  }

  fit(animate = true) {
    void this.sigma?.getCamera().animate({ x: 0.5, y: 0.5, ratio: 1, angle: 0 }, { duration: animate && !this.view.reducedMotion ? 400 : 0, easing: "cubicInOut" });
  }

  flyTo(nodeId: string, ratio = 0.35) {
    if (!this.sigma || !atlasGraph.hasNode(nodeId)) return false;
    const d = this.sigma.getNodeDisplayData(nodeId);
    if (!d) return false;
    void this.sigma.getCamera().animate({ x: d.x, y: d.y, ratio }, { duration: this.view.reducedMotion ? 0 : 400, easing: "cubicInOut" });
    return true;
  }

  viewportPos(nodeId: string): { x: number; y: number } | null {
    if (!this.sigma || !atlasGraph.hasNode(nodeId)) return null;
    const a = atlasGraph.getNodeAttributes(nodeId);
    return this.sigma.graphToViewport({ x: a.x, y: a.y });
  }

  cameraRatio() {
    return this.sigma?.getCamera().ratio ?? 1;
  }

  // ── Expand / collapse ───────────────────────────────────────────────────

  isExpanded(nodeId: string) {
    return this.expanded.has(nodeId);
  }

  async expand(nodeId: string, edgeKinds?: string[]) {
    try {
      const r = await api.get<{ node: GraphNodeDTO; nodes: GraphNodeDTO[]; edges: GraphEdgeDTO[] }>(`/api/graph/nodes/${encodeURIComponent(nodeId)}/neighbors`, { limit: 40, edgeKinds });
      const added = mergeSubgraph([r.node, ...r.nodes], r.edges, { origin: nodeId });
      this.expanded.add(nodeId);
      this.refresh();
      this.cb?.onExpand(nodeId, added.length);
      if (added.length) void this.startLayout(1_800);
      return added.length;
    } catch (e) {
      this.cb?.onError(e instanceof Error ? e.message : "Expand failed");
      return 0;
    }
  }

  collapse(nodeId: string, keep: Set<string>) {
    const removed = collapseGraph(nodeId, keep);
    this.expanded.delete(nodeId);
    this.refresh();
    return removed.length;
  }

  async toggleExpand(nodeId: string) {
    if (this.expanded.has(nodeId)) return this.collapse(nodeId, this.view.selected);
    return this.expand(nodeId);
  }

  setPinned(nodeId: string, pinned: boolean) {
    if (!atlasGraph.hasNode(nodeId)) return;
    atlasGraph.mergeNodeAttributes(nodeId, { pinned, fixed: pinned });
    this.sigma?.refresh({ skipIndexation: true });
  }
}

export const atlas = new AtlasController();

// Test/debug hook (Playwright reads node positions through it). Exposes no data the page doesn't already have.
if (typeof window !== "undefined") (window as unknown as { __atlas?: unknown }).__atlas = { atlas, graph: atlasGraph };
