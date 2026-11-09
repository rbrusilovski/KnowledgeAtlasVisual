import { withRoute } from "@/server/http/withRoute";
import { planSeedCleanup } from "@/server/services/taxonomy";

export const dynamic = "force-dynamic";

/** Admin: DRY RUN of the demo-taxonomy retirement. Execution is CLI-only (`pnpm taxonomy cleanup --yes <hash>`). */
export const GET = withRoute({ auth: "admin" }, async () => planSeedCleanup());
