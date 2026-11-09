import { withRoute } from "@/server/http/withRoute";
import { db } from "@/server/db";
import { SettingsPatch } from "@/shared/contracts/workspaces";

export const PATCH = withRoute({ auth: "required", body: SettingsPatch }, async ({ user, body }) =>
  db.user.update({ where: { id: user.id }, data: body, select: { id: true, name: true, reducedMotion: true, defaultLayout: true } }),
);
