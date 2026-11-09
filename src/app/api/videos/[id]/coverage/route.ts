import { withRoute } from "@/server/http/withRoute";
import { IdParam } from "@/shared/contracts/common";
import { findVideoId } from "@/server/services/catalog";
import { inspectVideo } from "@/server/services/coverage";

export const GET = withRoute({ auth: "optional", params: IdParam }, async ({ params }) => inspectVideo(await findVideoId(params.id)));
