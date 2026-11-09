import { z } from "zod";
import { csv, NodeId } from "./common";

export const NODE_TYPES = ["NICHE", "SUBNICHE", "CHANNEL", "VIDEO", "TOPIC"] as const;
export const EDGE_KINDS = ["CONTAINS", "IN_NICHE", "PUBLISHED", "MENTIONS", "CHANNEL_TOPIC", "FEATURED", "SIMILAR", "CO_TOPIC", "TOPIC_RELATED", "NICHE_TOPIC", "CO_DISCOVERED"] as const;
export type NodeTypeT = (typeof NODE_TYPES)[number];
export type EdgeKindT = (typeof EDGE_KINDS)[number];

export const GraphQuery = z.object({
  mode: z.enum(["global", "local"]).default("global"),
  focus: NodeId.optional(),
  depth: z.coerce.number().int().min(1).max(3).default(2),
  nodeTypes: csv(z.enum(NODE_TYPES)),
  edgeKinds: csv(z.enum(EDGE_KINDS)),
  nicheIds: csv(z.string().max(80)),
  minWeight: z.coerce.number().min(0).max(1).default(0),
  minSubscribers: z.coerce.number().int().nonnegative().optional(),
  maxSubscribers: z.coerce.number().int().nonnegative().optional(),
  publishedAfter: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(10).max(10_000).default(2000),
  topics: z.coerce.number().int().min(0).max(5000).default(400),
});
export type GraphQuery = z.infer<typeof GraphQuery>;

export const NeighborsQuery = z.object({
  edgeKinds: csv(z.enum(EDGE_KINDS)),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  cursor: z.string().max(200).optional(),
});

export const DeltaQuery = z.object({ since: z.coerce.bigint().nonnegative() });

export const PathQuery = z.object({ from: NodeId, to: NodeId, maxDepth: z.coerce.number().int().min(1).max(6).default(4) });

export interface GraphNodeDTO {
  id: string;
  type: NodeTypeT;
  label: string;
  size: number;
  communityId: number | null;
  attrs: Record<string, unknown>;
}

export interface GraphEdgeDTO {
  id: string;
  source: string;
  target: string;
  kind: EdgeKindT;
  weight: number;
  evidence?: Record<string, unknown> | null;
}

export interface SubgraphDTO {
  version: string;
  nodes: GraphNodeDTO[];
  edges: GraphEdgeDTO[];
  truncated: boolean;
  focus?: string;
}

export interface DeltaDTO {
  fromVersion: string;
  toVersion: string;
  nodes: GraphNodeDTO[];
  edges: GraphEdgeDTO[];
  removedNodeIds: string[];
  removedEdgeIds: string[];
  /** Too far behind: client should reload the full view. */
  reset: boolean;
}

export interface RelatedCreator {
  nodeId: string;
  youtubeId: string;
  title: string;
  thumbnailUrl: string | null;
  subscriberCount: number | null;
  inAtlas: boolean;
  score: number;
  reasons: { kind: string; text: string; weight: number }[];
}
