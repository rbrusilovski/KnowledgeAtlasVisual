"use client";

import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import Graph from "graphology";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { seedPositions } from "@/lib/atlas/graph";
import { TYPE_COLORS, nicheColor } from "@/lib/atlas/colors";
import { Skeleton } from "@/components/ui/misc";
import type { SubgraphDTO } from "@/shared/contracts/graph";

/** Small, self-contained local graph (separate sigma instance + its own graphology graph). */
export function MiniGraph({ focus, height = 280 }: { focus: string; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const q = useQuery({ queryKey: ["mini-graph", focus], queryFn: () => api.get<SubgraphDTO>("/api/graph", { mode: "local", focus, depth: 1, limit: 60, nodeTypes: ["NICHE", "SUBNICHE", "CHANNEL", "TOPIC"] }) });
  useEffect(() => {
    if (!q.data || !ref.current) return;
    let killed = false;
    let sigma: { kill(): void } | null = null;
    void (async () => {
      const [{ default: Sigma }, { default: fa2 }] = await Promise.all([import("sigma"), import("graphology-layout-forceatlas2")]);
      if (killed || !ref.current) return;
      const g = new Graph();
      const pos = seedPositions(q.data.nodes, q.data.edges);
      for (const n of q.data.nodes) {
        const p = pos.get(n.id)!;
        const color = n.type === "CHANNEL" ? nicheColor((n.attrs.niches as string[] | undefined)?.[0]) : TYPE_COLORS[n.type]!;
        g.addNode(n.id, { x: p.x, y: p.y, size: n.id === focus ? 9 : n.type === "TOPIC" ? 3 : 5, label: n.label, color });
      }
      for (const e of q.data.edges) if (!g.hasEdge(e.source, e.target) && g.hasNode(e.source) && g.hasNode(e.target)) g.addEdge(e.source, e.target, { size: 0.6, color: "rgba(160,170,190,0.18)" });
      fa2.assign(g, { iterations: 120, settings: { ...fa2.inferSettings(g), linLogMode: true } });
      const s = new Sigma(g, ref.current, {
        settings: { allowInvalidContainer: true, labelRenderedSizeThreshold: 6, enableNodeDrag: false, itemSizesReference: "screen" } as never,
        nodeReducer: (_k, d) => ({ ...d, labelColor: "#C9CDD6", labelSize: 11 }) as never,
      });
      s.on("clickNode", ({ node }) => router.push(node.startsWith("channel:") ? `/channels/${node.slice(8)}` : `/atlas?mode=local&focus=${encodeURIComponent(node)}&depth=2`));
      sigma = s;
    })();
    return () => {
      killed = true;
      sigma?.kill();
    };
  }, [q.data, focus, router]);
  if (q.isLoading) return <Skeleton style={{ height }} className="rounded-card" />;
  return <div ref={ref} className="canvas-bg rounded-card border border-border" style={{ height }} aria-label="Local graph" role="img" />;
}
