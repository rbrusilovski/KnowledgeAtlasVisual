/**
 * Expansion proposals: the ONLY way anything is added to or refreshed in the shared corpus. A proposal carries an
 * immutable, bounded scope; a human approves that exact scope once (by echoing its scopeHash); services, queue
 * producers and workers re-validate it before persisting data.
 */
import { z } from "zod";

const UC = z.string().regex(/^UC[A-Za-z0-9_-]{22}$/, "expected a UC… channel id");
const VID = z.string().regex(/^[A-Za-z0-9_-]{11}$/, "expected an 11-character video id");

/** Hard ceilings, independent of what a client or agent asks for. */
export const EXPANSION_LIMITS = {
  channelsPerProposal: 100,
  videosPerChannel: 5_000,
  backfillPages: 200,
  discoveryQueries: 10,
  discoveryCandidatesPerQuery: 50,
  discoveryChannelsToAdd: 25,
  syncChannels: 500,
  syncNewVideosPerChannel: 200,
  refreshChannels: 5_000,
  refreshVideos: 50_000,
} as const;

export const AddChannelsScope = z.object({
  kind: z.literal("ADD_CHANNELS"),
  channels: z.array(z.object({ youtubeId: UC, aliases: z.array(z.string().max(120)).max(10).default([]) })).min(1).max(EXPANSION_LIMITS.channelsPerProposal),
  /** Newest uploads to collect per channel in this operation (older history needs a BACKFILL_HISTORY proposal). */
  maxVideosPerChannel: z.number().int().min(0).max(EXPANSION_LIMITS.videosPerChannel),
  includeTranscripts: z.boolean().default(true),
});

export const DiscoverChannelsScope = z.object({
  kind: z.literal("DISCOVER_CHANNELS"),
  queries: z.array(z.string().trim().min(1).max(200)).min(1).max(EXPANSION_LIMITS.discoveryQueries),
  nicheId: z.string().max(100).optional(),
  regionCode: z.string().regex(/^[A-Z]{2}$/).optional(),
  relevanceLanguage: z.string().regex(/^[a-z]{2}(-[A-Za-z]{2,4})?$/).optional(),
  maxCandidatesPerQuery: z.number().int().min(1).max(EXPANSION_LIMITS.discoveryCandidatesPerQuery),
  /** Upper bound on channels added. Candidates already in Atlas are skipped and never count. */
  maxChannelsToAdd: z.number().int().min(0).max(EXPANSION_LIMITS.discoveryChannelsToAdd),
  maxVideosPerChannel: z.number().int().min(0).max(EXPANSION_LIMITS.videosPerChannel),
  includeTranscripts: z.boolean().default(true),
});

export const BackfillHistoryScope = z.object({
  kind: z.literal("BACKFILL_HISTORY"),
  channelYoutubeId: UC,
  /** Uploads-playlist pages (50 items each) this approval may scan, continuing from the saved checkpoint. */
  maxPages: z.number().int().min(1).max(EXPANSION_LIMITS.backfillPages),
  maxVideos: z.number().int().min(1).max(EXPANSION_LIMITS.videosPerChannel),
  includeTranscripts: z.boolean().default(true),
});

export const SyncUploadsScope = z.object({
  kind: z.literal("SYNC_UPLOADS"),
  channelYoutubeIds: z.array(UC).min(1).max(EXPANSION_LIMITS.syncChannels),
  /** New uploads per channel; the sync stops at the first known upload or this bound, whichever comes first. */
  maxNewVideosPerChannel: z.number().int().min(1).max(EXPANSION_LIMITS.syncNewVideosPerChannel),
  includeTranscripts: z.boolean().default(true),
});

export const RefreshMetadataScope = z.object({
  kind: z.literal("REFRESH_METADATA"),
  channelYoutubeIds: z.array(UC).max(EXPANSION_LIMITS.refreshChannels).default([]),
  videoYoutubeIds: z.array(VID).max(EXPANSION_LIMITS.refreshVideos).default([]),
  /** "all" refetches every part (compliance-grade refresh); "statistics" only updates statistics. */
  fields: z.enum(["all", "statistics"]),
  purpose: z.enum(["compliance", "statistics", "user"]),
});

export const ExpansionScope = z.discriminatedUnion("kind", [AddChannelsScope, DiscoverChannelsScope, BackfillHistoryScope, SyncUploadsScope, RefreshMetadataScope]);
export type ExpansionScope = z.infer<typeof ExpansionScope>;
export type ExpansionKind = ExpansionScope["kind"];
export const EXPANSION_KINDS = ["ADD_CHANNELS", "DISCOVER_CHANNELS", "BACKFILL_HISTORY", "SYNC_UPLOADS", "REFRESH_METADATA"] as const;

export const CreateProposalBody = z.object({
  scope: ExpansionScope,
  reason: z.string().trim().min(1).max(2_000),
  coverageGap: z.string().trim().max(2_000).optional(),
  title: z.string().trim().max(200).optional(),
});

export const DecideProposalBody = z.object({
  /** The scopeHash shown to the user. Approval only applies if it matches the stored, recomputed hash. */
  scopeHash: z.string().regex(/^[a-f0-9]{64}$/),
  note: z.string().trim().max(1_000).optional(),
});

export const ProposalListQuery = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "EXPIRED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED", "active"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export interface ProposalEstimate {
  channels: number;
  videos: number;
  quotaUnits: number;
  searchCalls: number;
  /** Plain-language bounds and what is not knowable in advance. */
  uncertainty: string | null;
  breakdown: { label: string; units: number; bucket: "general" | "search" }[];
}

export interface ProposalDTO {
  id: string;
  kind: ExpansionKind;
  source: "USER" | "CLAUDE" | "SYSTEM" | "CLI";
  status: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  title: string;
  reason: string;
  coverageGap: string | null;
  uncertainty: string | null;
  targetType: string;
  targetIds: string[];
  scope: ExpansionScope;
  scopeHash: string;
  estimate: { channels: number; videos: number; quotaUnits: number; searchCalls: number; isEstimate: true };
  createdByUserId: string | null;
  createdAt: string;
  expiresAt: string;
  approvedByUserId: string | null;
  approvedAt: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  executionDeadline: string | null;
  jobs: { total: number; done: number; failed: number };
  actual: { quotaUnits: number; searchCalls: number; results: Record<string, unknown> };
  error: string | null;
  /** Whether the current viewer may approve/reject it. */
  canDecide: boolean;
}
