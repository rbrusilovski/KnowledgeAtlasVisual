import { withRoute, json } from "@/server/http/withRoute";
import { healthReport } from "@/server/health";

export const dynamic = "force-dynamic";

export const GET = withRoute({ auth: "none", rateLimit: false }, async () => {
  const report = await healthReport();
  return json({ data: report }, { status: report.ok ? 200 : 503 });
});
