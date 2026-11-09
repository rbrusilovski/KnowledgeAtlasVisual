/**
 * Server-side YouTube policy gates (docs/COMPLIANCE_DECISIONS.md §11).
 *
 * Fixture mode serves a fictional dataset, so no API Data policy applies and every gate is open. In live mode each
 * capability is OFF until the owner records a decision and flips the corresponding env flag. An API key alone never
 * enables anything. Deletion / revocation purges are never gated.
 */
import { env } from "@/server/env";
import { AppError } from "@/server/errors";

export type PolicyCapability =
  /** Any YouTube Data API call that collects API Data into Atlas (channels/videos/playlists/search/sections/captions). */
  | "live-collection"
  /** Relationships/aggregates that combine API Data from channels of different content owners. */
  | "cross-owner-aggregation"
  /** Atlas-generated data from API Data: embeddings, topics, classification, AI extraction. */
  | "derived-data";

export interface PolicyStatus {
  mode: "live" | "fixture";
  liveCollection: boolean;
  crossOwnerAggregation: boolean;
  derivedData: boolean;
  /** Statistics may be retained up to 36 months (derived-metrics amendment accepted). */
  extendedStatisticsRetention: boolean;
}

export function policyStatus(): PolicyStatus {
  const fixture = env.YOUTUBE_MODE === "fixture";
  return {
    mode: env.YOUTUBE_MODE,
    liveCollection: fixture || env.YOUTUBE_LIVE_COLLECTION_ENABLED,
    crossOwnerAggregation: fixture || env.YOUTUBE_CROSS_OWNER_AGGREGATION_APPROVED,
    derivedData: fixture || env.YOUTUBE_DERIVED_METRICS_AMENDMENT_ACCEPTED,
    extendedStatisticsRetention: !fixture && env.YOUTUBE_DERIVED_METRICS_AMENDMENT_ACCEPTED,
  };
}

export function allowed(cap: PolicyCapability): boolean {
  const s = policyStatus();
  return cap === "live-collection" ? s.liveCollection : cap === "cross-owner-aggregation" ? s.crossOwnerAggregation : s.derivedData;
}

const MESSAGES: Record<PolicyCapability, string> = {
  "live-collection": "Live YouTube data collection is disabled (YOUTUBE_LIVE_COLLECTION_ENABLED=false) pending a recorded compliance decision.",
  "cross-owner-aggregation": "Cross-owner aggregation of YouTube API Data is disabled pending a recorded compliance decision.",
  "derived-data": "Deriving Atlas data from live YouTube API Data is disabled until the derived-metrics amendment decision is recorded.",
};

export class PolicyBlockedError extends AppError {
  constructor(readonly capability: PolicyCapability) {
    super("FORBIDDEN", MESSAGES[capability], { policy: capability });
  }
}

export function assertAllowed(cap: PolicyCapability) {
  if (!allowed(cap)) throw new PolicyBlockedError(cap);
}
