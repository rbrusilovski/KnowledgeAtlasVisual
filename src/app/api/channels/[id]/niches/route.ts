import { withRoute } from "@/server/http/withRoute";
import { IdParam } from "@/shared/contracts/common";
import { NicheOverrideBody } from "@/shared/contracts/channels";
import { findChannelId } from "@/server/services/catalog";
import { setManualNiches } from "@/server/services/classification";

export const PATCH = withRoute({ auth: "required", params: IdParam, body: NicheOverrideBody }, async ({ params, body, user }) => setManualNiches(await findChannelId(params.id), body.nicheIds, user.id));
