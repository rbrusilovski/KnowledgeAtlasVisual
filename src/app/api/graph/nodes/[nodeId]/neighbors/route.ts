import { z } from "zod";
import { withRoute, withMeta } from "@/server/http/withRoute";
import { NodeId } from "@/shared/contracts/common";
import { NeighborsQuery } from "@/shared/contracts/graph";
import { getNeighbors } from "@/server/services/graph";

export const GET = withRoute({ auth: "none", params: z.object({ nodeId: z.string().transform(decodeURIComponent).pipe(NodeId) }), query: NeighborsQuery }, async ({ params, query }) => {
  const r = await getNeighbors(params.nodeId, query);
  return withMeta({ node: r.node, nodes: r.nodes, edges: r.edges }, { nextCursor: r.nextCursor });
});
