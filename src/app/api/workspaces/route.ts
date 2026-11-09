import { withRoute, withMeta } from "@/server/http/withRoute";
import { WorkspaceBody } from "@/shared/contracts/workspaces";
import { listWorkspaces, createWorkspace } from "@/server/services/workspaces";

export const GET = withRoute({ auth: "required" }, async ({ user }) => listWorkspaces(user.id));
export const POST = withRoute({ auth: "required", body: WorkspaceBody }, async ({ user, body }) => withMeta(await createWorkspace(user.id, body), {}, 201));
