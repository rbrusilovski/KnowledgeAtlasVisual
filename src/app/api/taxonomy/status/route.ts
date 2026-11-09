import { withRoute } from "@/server/http/withRoute";
import { taxonomyStatus } from "@/server/services/taxonomy";

export const dynamic = "force-dynamic";

export const GET = withRoute({ auth: "none" }, async () => taxonomyStatus());
