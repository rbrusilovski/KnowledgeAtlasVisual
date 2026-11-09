import { withRoute } from "@/server/http/withRoute";
import { PathQuery } from "@/shared/contracts/graph";
import { findPath } from "@/server/services/graph";
import { notFound } from "@/server/errors";

export const GET = withRoute({ auth: "none", query: PathQuery }, async ({ query }) => {
  const p = await findPath(query.from, query.to, query.maxDepth);
  if (!p) throw notFound(`Path within ${query.maxDepth} hops`);
  return p;
});
