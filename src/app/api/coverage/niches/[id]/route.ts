import { withRoute } from "@/server/http/withRoute";
import { IdParam } from "@/shared/contracts/common";
import { inspectNiche } from "@/server/services/coverage";

export const GET = withRoute({ auth: "required", params: IdParam }, async ({ params }) => inspectNiche(params.id));
