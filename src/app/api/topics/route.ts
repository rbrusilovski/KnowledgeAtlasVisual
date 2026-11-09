import { z } from "zod";
import { withRoute, withMeta } from "@/server/http/withRoute";
import { Cursor, Limit } from "@/shared/contracts/common";
import { decodeCursor, encodeCursor } from "@/server/http/cursor";
import { listTopics } from "@/server/services/topics";

export const GET = withRoute({ auth: "none", query: z.object({ q: z.string().trim().max(100).optional(), limit: Limit, cursor: Cursor }) }, async ({ query }) => {
  const offset = decodeCursor<{ o: number }>(query.cursor)?.o ?? 0;
  const rows = await listTopics({ q: query.q, limit: query.limit + 1, offset });
  return withMeta(rows.slice(0, query.limit).map((t) => ({ ...t, nodeId: `topic:${t.slug}` })), { nextCursor: rows.length > query.limit ? encodeCursor({ o: offset + query.limit }) : null });
});
