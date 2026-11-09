import { withRoute } from "@/server/http/withRoute";
import { DeltaQuery } from "@/shared/contracts/graph";
import { getDelta } from "@/server/services/graph";

export const dynamic = "force-dynamic";

export const GET = withRoute({ auth: "none", query: DeltaQuery }, async ({ query }) => getDelta(query.since));
