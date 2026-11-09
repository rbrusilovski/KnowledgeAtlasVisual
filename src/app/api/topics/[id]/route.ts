import { withRoute } from "@/server/http/withRoute";
import { IdParam } from "@/shared/contracts/common";
import { topicDetail } from "@/server/services/catalog";

export const GET = withRoute({ auth: "none", params: IdParam }, async ({ params }) => topicDetail(decodeURIComponent(params.id)));
