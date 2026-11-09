import { withRoute } from "@/server/http/withRoute";
import { IdParam } from "@/shared/contracts/common";
import { ExportQuery } from "@/shared/contracts/workspaces";
import { exportCollection } from "@/server/services/workspaces";

export const GET = withRoute({ auth: "required", params: IdParam, query: ExportQuery }, async ({ user, params, query }) => {
  const f = await exportCollection(user.id, params.id, query.format);
  return new Response(f.body, { headers: { "content-type": f.contentType, "content-disposition": `attachment; filename="${f.filename}"`, "cache-control": "no-store" } });
});
