/**
 * The atlas graphology instance lives OUTSIDE React (spec §10.2). React drives settings/reducers only.
 * Node attributes: x, y, size (base), label, kind (NodeType), communityId, data (server attrs), image, fixed,
 * enterAt (animation), expandedFrom.
 */
import Graph from "graphology";
import type { GraphEdgeDTO, GraphNodeDTO, NodeTypeT, EdgeKindT } from "@/shared/contracts/graph";

export interface AtlasNodeAttrs {
  x: number;
  y: number;
  size: number;
  label: string;
  kind: NodeTypeT;
  communityId: number | null;
  data: Record<string, unknown>;
  image?: string;
  fixed?: boolean;
  pinned?: boolean;
  enterAt?: number;
  expandedFrom?: string;
  [k: string]: unknown;
}
export interface AtlasEdgeAttrs {
  kind: EdgeKindT;
  weight: number;
  size: number;
  [k: string]: unknown;
}

export type AtlasGraph = Graph<AtlasNodeAttrs, AtlasEdgeAttrs>;

const g = globalThis as unknown as { __atlasGraph?: AtlasGraph };
export const atlasGraph: AtlasGraph = (g.__atlasGraph ??= new Graph<AtlasNodeAttrs, AtlasEdgeAttrs>({ type: "mixed", multi: false, allowSelfLoops: false }));

/** Graph version the client has merged up to (for /api/graph/delta?since=). */
export const graphMeta = { version: "0", listeners: new Set<() => void>() };
export function notifyGraphChange() {
  for (const l of graphMeta.listeners) l();
}

const jitter = (r: number) => (Math.random() - 0.5) * r;

function nodeAttrs(n: GraphNodeDTO, pos: { x: number; y: number }, extra: Partial<AtlasNodeAttrs> = {}): AtlasNodeAttrs {
  const thumb = typeof n.attrs.thumbnailUrl === "string" ? n.attrs.thumbnailUrl : undefined;
  return {
    x: pos.x,
    y: pos.y,
    size: n.size,
    label: n.label,
    kind: n.type,
    communityId: n.communityId,
    data: n.attrs,
    ...(n.type === "CHANNEL" && thumb ? { image: thumb } : {}),
    ...extra,
  };
}

/** Structural seed positions so ForceAtlas2 converges quickly into niche clusters. */
export function seedPositions(nodes: GraphNodeDTO[], edges: GraphEdgeDTO[]): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  const niches = nodes.filter((n) => n.type === "NICHE").sort((a, b) => a.id.localeCompare(b.id));
  const R = 1000;
  niches.forEach((n, i) => {
    const a = (i / Math.max(1, niches.length)) * Math.PI * 2;
    pos.set(n.id, { x: Math.cos(a) * R, y: Math.sin(a) * R });
  });
  const childrenOf = new Map<string, string[]>();
  for (const n of nodes) if (n.type === "SUBNICHE") {
    const parent = `niche:${String(n.attrs.parent ?? "")}`;
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), n.id]);
  }
  for (const [parent, kids] of childrenOf) {
    const c = pos.get(parent) ?? { x: jitter(R), y: jitter(R) };
    kids.forEach((k, i) => {
      const a = (i / kids.length) * Math.PI * 2;
      pos.set(k, { x: c.x + Math.cos(a) * 260, y: c.y + Math.sin(a) * 260 });
    });
  }
  for (const n of nodes) {
    if (pos.has(n.id) || n.type !== "CHANNEL") continue;
    const sub = (n.attrs.subniches as string[] | undefined)?.[0];
    const c = (sub && pos.get(`subniche:${sub}`)) || { x: jitter(R * 1.5), y: jitter(R * 1.5) };
    pos.set(n.id, { x: c.x + jitter(160), y: c.y + jitter(160) });
  }
  // Topics/videos: centroid of already-placed neighbors.
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    adj.set(e.source, [...(adj.get(e.source) ?? []), e.target]);
    adj.set(e.target, [...(adj.get(e.target) ?? []), e.source]);
  }
  for (const n of nodes) {
    if (pos.has(n.id)) continue;
    const placed = (adj.get(n.id) ?? []).map((m) => pos.get(m) ?? (atlasGraph.hasNode(m) ? atlasGraph.getNodeAttributes(m) : undefined)).filter((p): p is { x: number; y: number } => Boolean(p));
    if (placed.length) {
      const cx = placed.reduce((s, p) => s + p.x, 0) / placed.length;
      const cy = placed.reduce((s, p) => s + p.y, 0) / placed.length;
      pos.set(n.id, { x: cx + jitter(120), y: cy + jitter(120) });
    } else pos.set(n.id, { x: jitter(R * 2), y: jitter(R * 2) });
  }
  return pos;
}

export interface MergeOptions {
  /** Remove nodes not present in the payload (view switch). Pinned positions are kept separately. */
  replace?: boolean;
  /** Animate new nodes in from this node's position. */
  origin?: string;
  pinned?: Map<string, { x: number; y: number; pinned: boolean }>;
}

export function mergeSubgraph(nodes: GraphNodeDTO[], edges: GraphEdgeDTO[], opts: MergeOptions = {}): string[] {
  const added: string[] = [];
  const incoming = new Set(nodes.map((n) => n.id));
  if (opts.replace) {
    atlasGraph.forEachNode((id) => {
      if (!incoming.has(id)) atlasGraph.dropNode(id);
    });
  }
  const originPos = opts.origin && atlasGraph.hasNode(opts.origin) ? atlasGraph.getNodeAttributes(opts.origin) : null;
  const seeds = originPos ? null : seedPositions(nodes.filter((n) => !atlasGraph.hasNode(n.id)), edges);
  const now = performance.now();
  for (const n of nodes) {
    const pin = opts.pinned?.get(n.id);
    if (atlasGraph.hasNode(n.id)) {
      atlasGraph.mergeNodeAttributes(n.id, { size: n.size, label: n.label, communityId: n.communityId, data: n.attrs, ...(n.type === "CHANNEL" && typeof n.attrs.thumbnailUrl === "string" ? { image: n.attrs.thumbnailUrl } : {}) });
      if (pin) atlasGraph.mergeNodeAttributes(n.id, { x: pin.x, y: pin.y, fixed: pin.pinned, pinned: pin.pinned });
      continue;
    }
    const pos = pin ?? (originPos ? { x: originPos.x + jitter(40), y: originPos.y + jitter(40) } : (seeds!.get(n.id) ?? { x: jitter(1000), y: jitter(1000) }));
    atlasGraph.addNode(n.id, nodeAttrs(n, pos, { enterAt: now, ...(opts.origin ? { expandedFrom: opts.origin } : {}), ...(pin ? { fixed: pin.pinned, pinned: pin.pinned } : {}) }));
    added.push(n.id);
  }
  for (const e of edges) {
    if (!atlasGraph.hasNode(e.source) || !atlasGraph.hasNode(e.target) || e.source === e.target) continue;
    const attrs: AtlasEdgeAttrs = { kind: e.kind, weight: e.weight, size: 0.4 + e.weight * 1.1 };
    if (atlasGraph.hasEdge(e.id)) atlasGraph.mergeEdgeAttributes(e.id, attrs);
    else if (!atlasGraph.hasEdge(e.source, e.target)) atlasGraph.addEdgeWithKey(e.id, e.source, e.target, attrs);
  }
  notifyGraphChange();
  return added;
}

/** Remove nodes added by expanding `origin` that nothing else holds onto. */
export function collapse(origin: string, keep: Set<string>): string[] {
  const removed: string[] = [];
  atlasGraph.forEachNode((id, a) => {
    if (a.expandedFrom === origin && !keep.has(id) && !a.pinned) removed.push(id);
  });
  for (const id of removed) atlasGraph.dropNode(id);
  if (removed.length) notifyGraphChange();
  return removed;
}

export function removeIds(nodeIds: string[], edgeIds: string[]) {
  for (const e of edgeIds) if (atlasGraph.hasEdge(e)) atlasGraph.dropEdge(e);
  for (const n of nodeIds) if (atlasGraph.hasNode(n)) atlasGraph.dropNode(n);
  notifyGraphChange();
}

// ── Filters (applied by reducers, no graph rebuild) ────────────────────────

export interface AtlasFilters {
  types: NodeTypeT[] | null;
  kinds: EdgeKindT[] | null;
  niches: string[] | null;
  minSubs: number | null;
  maxSubs: number | null;
  recencyDays: number | null;
  minWeight: number;
  transcript: boolean;
  collection: string | null;
}

export function computeVisible(f: AtlasFilters, hidden: Set<string>, members: Set<string> | null): Set<string> {
  const pass = new Set<string>();
  const nicheSet = f.niches?.length ? new Set(f.niches) : null;
  const cutoff = f.recencyDays ? Date.now() - f.recencyDays * 86_400_000 : null;
  const channelOk = new Set<string>();
  atlasGraph.forEachNode((id, a) => {
    if (a.kind !== "CHANNEL") return;
    const d = a.data as { subscriberCount?: number | null; latestVideoAt?: string | null; subniches?: string[]; niches?: string[]; transcriptVideos?: number };
    if (f.minSubs !== null && (d.subscriberCount ?? 0) < f.minSubs) return;
    if (f.maxSubs !== null && (d.subscriberCount ?? 0) > f.maxSubs) return;
    if (cutoff && (!d.latestVideoAt || Date.parse(d.latestVideoAt) < cutoff)) return;
    if (nicheSet && ![...(d.subniches ?? []), ...(d.niches ?? [])].some((s) => nicheSet.has(s))) return;
    if (f.transcript && !(d.transcriptVideos ?? 0)) return;
    channelOk.add(id);
  });
  const memberNeighborhood = members ? new Set<string>([...members].flatMap((m) => (atlasGraph.hasNode(m) ? [m, ...atlasGraph.neighbors(m)] : []))) : null;
  atlasGraph.forEachNode((id, a) => {
    if (hidden.has(id)) return;
    if (f.types && !f.types.includes(a.kind)) return;
    if (memberNeighborhood && !memberNeighborhood.has(id)) return;
    switch (a.kind) {
      case "CHANNEL":
        if (!channelOk.has(id)) return;
        break;
      case "NICHE":
      case "SUBNICHE":
        if (nicheSet && !nicheSet.has(id.slice(id.indexOf(":") + 1))) return;
        break;
      case "VIDEO": {
        const d = a.data as { channel?: string; publishedAt?: string; hasTranscript?: boolean };
        if (d.channel && atlasGraph.hasNode(`channel:${d.channel}`) && !channelOk.has(`channel:${d.channel}`)) return;
        if (cutoff && d.publishedAt && Date.parse(d.publishedAt) < cutoff) return;
        if (f.transcript && !d.hasTranscript) return;
        break;
      }
      case "TOPIC":
        if (nicheSet || f.minSubs !== null || f.maxSubs !== null || cutoff || f.transcript) {
          if (!atlasGraph.neighbors(id).some((n) => channelOk.has(n) || (nicheSet && n.startsWith("subniche:") && nicheSet.has(n.slice(9))))) return;
        }
        break;
    }
    pass.add(id);
  });
  return pass;
}

export function nodeYouTubeUrl(id: string): string | null {
  if (id.startsWith("channel:")) return `https://www.youtube.com/channel/${id.slice(8)}`;
  if (id.startsWith("video:")) return `https://www.youtube.com/watch?v=${id.slice(6)}`;
  return null;
}

export function nodeAppUrl(id: string): string {
  if (id.startsWith("channel:")) return `/channels/${id.slice(8)}`;
  if (id.startsWith("video:")) return `/videos/${id.slice(6)}`;
  return `/atlas?focus=${encodeURIComponent(id)}&mode=local&depth=2`;
}
