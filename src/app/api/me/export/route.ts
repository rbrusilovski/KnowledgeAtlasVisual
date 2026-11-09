import { withRoute, jsonReplacer } from "@/server/http/withRoute";
import { exportUserData } from "@/server/services/workspaces";

export const GET = withRoute({ auth: "required" }, async ({ user }) => {
  const data = await exportUserData(user.id);
  return new Response(JSON.stringify(data, jsonReplacer, 2), { headers: { "content-type": "application/json", "content-disposition": `attachment; filename="atlas-export-${new Date().toISOString().slice(0, 10)}.json"`, "cache-control": "no-store" } });
});
