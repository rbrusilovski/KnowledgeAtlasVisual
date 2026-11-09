import { z } from "zod";
import { withRoute } from "@/server/http/withRoute";
import { enqueue } from "@/server/jobs";
import { unclassifiedVideoIds } from "@/server/services/taxonomy";

/**
 * Admin: queue taxonomy classification for already-collected videos that have no dynamic category yet.
 * Internal derived data only — collects nothing from YouTube.
 */
export const POST = withRoute({ auth: "admin", body: z.object({ limit: z.number().int().min(1).max(20_000).default(5_000) }).default({ limit: 5_000 }) }, async ({ body }) => {
  const ids = await unclassifiedVideoIds(body.limit);
  for (let i = 0; i < ids.length; i += 200) await enqueue.taxonomy(ids.slice(i, i + 200));
  return { queued: ids.length };
});
