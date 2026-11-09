"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

export type LiveEventType = "job.progress" | "job.completed" | "job.failed" | "graph.delta" | "quota.updated" | "proposal.created" | "proposal.updated";
export interface LiveEvent {
  id: string;
  type: LiveEventType;
  data: Record<string, unknown>;
}
type Listener = (e: LiveEvent) => void;

export interface JobInfo {
  jobId: string;
  queue: string;
  pct?: number;
  step?: string;
  title?: string;
  state: "active" | "completed" | "failed";
  updatedAt: number;
}

interface LiveCtx {
  connected: boolean;
  subscribe(fn: Listener): () => void;
  jobs: JobInfo[];
}

const Ctx = createContext<LiveCtx>({ connected: false, subscribe: () => () => {}, jobs: [] });

const VISIBLE_QUEUES = new Set(["ingest-channel", "sync-channel", "backfill-history", "discover-channels", "refresh-metadata"]);

/** One EventSource per tab; fan-out to subscribers. The browser resends Last-Event-ID on reconnect. */
export function LiveProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const listeners = useRef(new Set<Listener>());
  const qc = useQueryClient();

  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const open = () => {
      es = new EventSource("/api/events");
      es.onopen = () => setConnected(true);
      es.onerror = () => {
        setConnected(false);
        if (es?.readyState === EventSource.CLOSED) retry = setTimeout(open, 5_000);
      };
      const handler = (type: LiveEventType) => (msg: MessageEvent) => {
        let data: Record<string, unknown> = {};
        try {
          data = JSON.parse(msg.data);
        } catch {
          return;
        }
        const ev: LiveEvent = { id: msg.lastEventId, type, data };
        for (const l of listeners.current) l(ev);
        if (type.startsWith("job.")) onJob(ev);
        if (type === "quota.updated") void qc.invalidateQueries({ queryKey: ["quota"] });
        if (type.startsWith("proposal.")) {
          void qc.invalidateQueries({ queryKey: ["proposals"] });
          void qc.invalidateQueries({ queryKey: ["coverage"] });
        }
      };
      for (const t of ["job.progress", "job.completed", "job.failed", "graph.delta", "quota.updated", "proposal.created", "proposal.updated"] as const) es.addEventListener(t, handler(t));
    };
    const onJob = (ev: LiveEvent) => {
      const d = ev.data as { jobId: string; queue: string; pct?: number; step?: string; title?: string; error?: string; channel?: string; result?: { videos?: { created?: number } } };
      if (!VISIBLE_QUEUES.has(d.queue)) return;
      setJobs((prev) => {
        const cur = prev.find((j) => j.jobId === d.jobId);
        const next: JobInfo = {
          jobId: d.jobId,
          queue: d.queue,
          pct: ev.type === "job.completed" ? 100 : (d.pct ?? cur?.pct),
          step: d.step ?? cur?.step,
          title: d.title ?? cur?.title,
          state: ev.type === "job.completed" ? "completed" : ev.type === "job.failed" ? "failed" : "active",
          updatedAt: Date.now(),
        };
        return [next, ...prev.filter((j) => j.jobId !== d.jobId)].filter((j) => j.state === "active" || Date.now() - j.updatedAt < 8_000).slice(0, 20);
      });
      if (d.channel === "user") {
        if (ev.type === "job.completed" && d.queue === "ingest-channel") toast.success(`${d.title ?? "Channel"} added to the atlas`, { description: d.result?.videos?.created !== undefined ? `${d.result.videos.created} videos ingested` : undefined });
        if (ev.type === "job.failed") toast.error("Ingestion failed", { description: d.error });
      }
    };
    open();
    const gc = setInterval(() => setJobs((p) => p.filter((j) => j.state === "active" || Date.now() - j.updatedAt < 8_000)), 4_000);
    return () => {
      es?.close();
      if (retry) clearTimeout(retry);
      clearInterval(gc);
    };
  }, [qc]);

  const value: LiveCtx = {
    connected,
    jobs,
    subscribe: (fn) => {
      listeners.current.add(fn);
      return () => listeners.current.delete(fn);
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useLive = () => useContext(Ctx);
