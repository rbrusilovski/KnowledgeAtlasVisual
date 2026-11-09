import { z } from "zod";
import type { ProposalDTO } from "./expansion";

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
  /** "proposed": a pending ADD_CHANNELS proposal awaiting the user's explicit approval (nothing collected yet). */
  status: "proposed" | "exists" | "needsConfirmation";
  youtubeId?: string;
  channel?: { id: string; title: string; nodeId: string } | null;
  proposal?: ProposalDTO;
  cost?: { bucket: string; units: number };
  reason?: string;
}
