"use client";

import { useEffect, useRef, useState } from "react";
import Graph from "graphology";

function rand(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
}

export function GraphBench() {
  const ref = useRef<HTMLDivElement>(null);
  const [nodes, setNodes] = useState(10_000);
  const [fps, setFps] = useState(0);
  const [info, setInfo] = useState("");
  useEffect(() => {
    let killed = false;
    let sigma: { kill(): void; getCamera(): { animate(s: object, o: object): Promise<void> } } | null = null;
    let raf = 0;
    void (async () => {
      const { default: Sigma } = await import("sigma");
      if (killed || !ref.current) return;
      const r = rand(7);
      const g = new Graph();
      const clusters = 40;
      const t0 = performance.now();
      for (let i = 0; i < nodes; i++) {
        const c = i % clusters;
        const a = (c / clusters) * Math.PI * 2;
        g.addNode(i, { x: Math.cos(a) * 100 + (r() - 0.5) * 40, y: Math.sin(a) * 100 + (r() - 0.5) * 40, size: 1 + r() * 4, color: `hsl(${(c * 137) % 360},45%,62%)`, label: `n${i}` });
      }
      const edges = nodes * 4;
      for (let i = 0; i < edges; i++) {
        const s = Math.floor(r() * nodes);
        const t = r() < 0.85 ? Math.floor(s / clusters) * clusters + Math.floor(r() * clusters) : Math.floor(r() * nodes);
        if (s !== t && t < nodes && !g.hasEdge(s, t)) g.addEdge(s, t, { size: 0.4, color: "rgba(160,170,190,0.12)" });
      }
      const s = new Sigma(g, ref.current, { settings: { allowInvalidContainer: true, labelRenderedSizeThreshold: 12 } as never });
      sigma = s as never;
      setInfo(`${g.order.toLocaleString()} nodes · ${g.size.toLocaleString()} edges · built in ${Math.round(performance.now() - t0)} ms`);
      // Continuous camera motion to measure interactive FPS.
      let frames = 0;
      let last = performance.now();
      let angle = 0;
      const loop = () => {
        frames++;
        angle += 0.01;
        (s as unknown as { getCamera(): { setState(x: object): void } }).getCamera().setState({ x: 0.5 + Math.cos(angle) * 0.1, y: 0.5 + Math.sin(angle) * 0.1, ratio: 0.8 + Math.sin(angle / 2) * 0.3 });
        const now = performance.now();
        if (now - last > 1000) {
          setFps(Math.round((frames * 1000) / (now - last)));
          frames = 0;
          last = now;
        }
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    })();
    return () => {
      killed = true;
      cancelAnimationFrame(raf);
      sigma?.kill();
    };
  }, [nodes]);
  return (
    <main className="flex h-dvh flex-col bg-bg-0">
      <header className="flex items-center gap-4 border-b border-border px-4 py-2 text-sm text-text-2">
        <span className="text-text-1">Graph bench (dev only)</span>
        <select value={nodes} onChange={(e) => setNodes(Number(e.target.value))} className="rounded-control border border-border bg-bg-3 px-2 py-1" aria-label="Node count">
          {[1000, 5000, 10000, 20000].map((n) => <option key={n} value={n}>{n.toLocaleString()} nodes</option>)}
        </select>
        <span>{info}</span>
        <span className="num ml-auto text-lg text-text-1" data-testid="fps">{fps} FPS</span>
      </header>
      <div ref={ref} className="canvas-bg min-h-0 flex-1" />
    </main>
  );
}
