import { withRoute } from "@/server/http/withRoute";
import { db } from "@/server/db";
import { revoke } from "@/server/youtube/oauth";
import { purgeYouTubeConnectionData } from "@/server/services/workspaces";

/** Revoke the YouTube connection and delete data obtained through it (owner captions). */
export const DELETE = withRoute({ auth: "required" }, async ({ user }) => {
  const c = await db.youTubeConnection.findUnique({ where: { userId: user.id }, select: { channelIds: true } });
  if (!c) return { revoked: false };
  await revoke(user.id);
  await purgeYouTubeConnectionData(user.id, c.channelIds);
  return { revoked: true };
});
