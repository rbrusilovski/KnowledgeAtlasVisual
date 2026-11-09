import { withRoute, withMeta } from "@/server/http/withRoute";
import { GraphQuery } from "@/shared/contracts/graph";
import { getSubgraph } from "@/server/services/graph";

export const dynamic = "force-dynamic";

export const GET = withRoute({ auth: "none", query: GraphQuery }, async ({ query }) => {
  const t0 = performance.now();
  const g = await getSubgraph(query);
  return withMeta(g, { ms: Math.round(performance.now() - t0), nodes: g.nodes.length, edges: g.edges.length });
});
