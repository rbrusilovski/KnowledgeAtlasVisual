import { z } from "zod";

export const JobState = z.enum(["waiting", "active", "delayed", "completed", "failed", "prioritized", "waiting-children", "unknown"]);

export interface JobStatus {
  id: string;
  queue: string;
  state: z.infer<typeof JobState>;
  progress: { pct?: number; step?: string; [k: string]: unknown } | number | null;
  attemptsMade: number;
  failedReason?: string;
  result?: unknown;
  createdAt: string;
  finishedAt?: string;
}

export interface AddChannelResult {
  status: "queued" | "exists" | "needsConfirmation";
  youtubeId?: string;
  channel?: { id: string; title: string; nodeId: string } | null;
  jobId?: string;
  cost?: { bucket: string; units: number };
  reason?: string;
}
