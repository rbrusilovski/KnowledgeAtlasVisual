import { withRoute } from "@/server/http/withRoute";
import { inspectAtlas } from "@/server/services/coverage";
import { policyStatus } from "@/server/youtube";

export const dynamic = "force-dynamic";

/** Read-only atlas-wide coverage: field groups, completeness, history, derived data, retention, approvals. */
export const GET = withRoute({ auth: "required" }, async () => ({ ...(await inspectAtlas()), policy: policyStatus() }));
