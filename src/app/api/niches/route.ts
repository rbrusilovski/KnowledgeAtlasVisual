import { withRoute } from "@/server/http/withRoute";
import { nicheTree } from "@/server/services/catalog";

export const GET = withRoute({ auth: "none" }, async () => nicheTree());
