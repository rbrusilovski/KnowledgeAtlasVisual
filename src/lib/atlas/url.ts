"use client";

import { parseAsArrayOf, parseAsBoolean, parseAsFloat, parseAsInteger, parseAsString, parseAsStringLiteral, useQueryStates } from "nuqs";
import { useMemo } from "react";
import { EDGE_KINDS, NODE_TYPES } from "@/shared/contracts/graph";
import type { AtlasFilters } from "./graph";

/** Focus, mode and filters live in the URL so views are linkable: /atlas?focus=channel:UC…&mode=local&depth=2 */
export const atlasParams = {
  mode: parseAsStringLiteral(["global", "local"] as const).withDefault("global"),
  focus: parseAsString,
  depth: parseAsInteger.withDefault(2),
  types: parseAsArrayOf(parseAsStringLiteral(NODE_TYPES)),
  kinds: parseAsArrayOf(parseAsStringLiteral(EDGE_KINDS)),
  niches: parseAsArrayOf(parseAsString),
  minSubs: parseAsInteger,
  maxSubs: parseAsInteger,
  recency: parseAsInteger,
  minWeight: parseAsFloat.withDefault(0),
  transcript: parseAsBoolean.withDefault(false),
  collection: parseAsString,
  q: parseAsString,
};

export function useAtlasParams() {
  const [p, set] = useQueryStates(atlasParams, { history: "replace" });
  const filters: AtlasFilters = useMemo(
    () => ({
      types: p.types?.length ? p.types : null,
      kinds: p.kinds?.length ? p.kinds : null,
      niches: p.niches?.length ? p.niches : null,
      minSubs: p.minSubs,
      maxSubs: p.maxSubs,
      recencyDays: p.recency,
      minWeight: p.minWeight,
      transcript: p.transcript,
      collection: p.collection,
    }),
    [p.types, p.kinds, p.niches, p.minSubs, p.maxSubs, p.recency, p.minWeight, p.transcript, p.collection],
  );
  const activeFilterCount = [filters.types, filters.kinds, filters.niches, filters.minSubs, filters.maxSubs, filters.recencyDays, filters.minWeight || null, filters.transcript || null, filters.collection].filter((x) => x !== null && x !== undefined).length;
  return { params: p, setParams: set, filters, activeFilterCount };
}
