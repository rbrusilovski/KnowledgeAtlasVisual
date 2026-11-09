import { withRoute } from "@/server/http/withRoute";
import { IdParam } from "@/shared/contracts/common";
import { nicheDetail } from "@/server/services/catalog";

export const GET = withRoute({ auth: "none", params: IdParam }, async ({ params }) => nicheDetail(decodeURIComponent(params.id)));
