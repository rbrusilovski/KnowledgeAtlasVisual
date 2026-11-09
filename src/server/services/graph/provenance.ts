import type { EdgeKind } from "@/server/db";

/**
 * What kind of claim each edge kind makes. Users and Claude must be able to tell a YouTube-sourced fact from an
 * Atlas-generated relationship (prompt §9.2/§9.3, deferred finding D8).
 *  • youtube-fact   — stated directly by YouTube API Data (ownership, a channel featuring another channel)
 *  • atlas-taxonomy — Atlas's own curated taxonomy structure
 *  • atlas-observed — an observation Atlas made (two channels returned by the same discovery search)
 *  • atlas-inferred — computed by Atlas models (classification, TF-IDF topics, embeddings, co-occurrence)
 */
export type EdgeBasis = "youtube-fact" | "atlas-taxonomy" | "atlas-observed" | "atlas-inferred";

export interface EdgeProvenance {
  basis: EdgeBasis;
  /** FACT for YouTube-stated relations; INFERRED for everything Atlas generated. */
  label: "FACT" | "INFERRED";
  method: string;
  explanation: string;
}

export const EDGE_PROVENANCE: Record<EdgeKind, EdgeProvenance> = {
  CONTAINS: { basis: "atlas-taxonomy", label: "INFERRED", method: "seed taxonomy", explanation: "Subniche belongs to this niche in Atlas's taxonomy." },
  IN_NICHE: { basis: "atlas-inferred", label: "INFERRED", method: "hybrid classifier (embedding + keywords + topic categories)", explanation: "Atlas classified the channel into this subniche; weight = classification confidence." },
  PUBLISHED: { basis: "youtube-fact", label: "FACT", method: "YouTube uploads playlist", explanation: "The channel published this video (YouTube Data API)." },
  MENTIONS: { basis: "atlas-inferred", label: "INFERRED", method: "TF-IDF keyphrases / optional AI extraction", explanation: "Atlas extracted this topic from the video's title, tags, description or a corpus transcript." },
  CHANNEL_TOPIC: { basis: "atlas-inferred", label: "INFERRED", method: "aggregated video topics", explanation: "Topic recurs across the channel's videos (Atlas aggregation)." },
  NICHE_TOPIC: { basis: "atlas-inferred", label: "INFERRED", method: "aggregated member-channel topics", explanation: "Topic is prominent among channels Atlas placed in this subniche." },
  FEATURED: { basis: "youtube-fact", label: "FACT", method: "YouTube channelSections", explanation: "The channel features the other channel on its YouTube page." },
  SIMILAR: { basis: "atlas-inferred", label: "INFERRED", method: "embedding cosine similarity", explanation: "Channel descriptions and recent titles are semantically similar (Atlas embeddings)." },
  CO_TOPIC: { basis: "atlas-inferred", label: "INFERRED", method: "weighted Jaccard over channel topics", explanation: "The channels share Atlas-extracted topics." },
  TOPIC_RELATED: { basis: "atlas-inferred", label: "INFERRED", method: "normalized PMI of topic co-occurrence", explanation: "Topics co-occur in the same videos more often than chance." },
  CO_DISCOVERED: { basis: "atlas-observed", label: "INFERRED", method: "co-occurrence in discovery results", explanation: "Both channels were returned by the same Atlas discovery search (weak signal)." },
};

export function edgeProvenance(kind: EdgeKind): EdgeProvenance {
  return EDGE_PROVENANCE[kind];
}
