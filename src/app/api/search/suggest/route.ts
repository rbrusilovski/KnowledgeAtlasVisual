import { withRoute, withMeta } from "@/server/http/withRoute";
import { SuggestQuery } from "@/shared/contracts/search";
import { suggest } from "@/server/services/search";

export const dynamic = "force-dynamic";

export const GET = withRoute({ auth: "none", query: SuggestQuery }, async ({ query }) => {
  const t0 = performance.now();
  const items = await suggest(query.q, query.limit);
  return withMeta(items, { ms: Math.round(performance.now() - t0) });
});
