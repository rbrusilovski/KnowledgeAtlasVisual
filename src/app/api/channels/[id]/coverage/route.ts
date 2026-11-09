import { withRoute } from "@/server/http/withRoute";
import { IdParam } from "@/shared/contracts/common";
import { findChannelId } from "@/server/services/catalog";
import { inspectChannel } from "@/server/services/coverage";

export const GET = withRoute({ auth: "optional", params: IdParam }, async ({ params }) => inspectChannel(await findChannelId(params.id)));
