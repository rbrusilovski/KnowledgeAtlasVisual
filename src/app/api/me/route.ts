import { withRoute } from "@/server/http/withRoute";
import { db } from "@/server/db";
import { deleteAccount } from "@/server/services/workspaces";

export const GET = withRoute({ auth: "required" }, async ({ user }) => {
  const u = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { id: true, name: true, email: true, image: true, role: true, reducedMotion: true, defaultLayout: true, createdAt: true, youtubeConnection: { select: { channelIds: true, createdAt: true } } } });
  return u;
});

/** Account + data deletion (cascades all personal data; revokes YouTube-connection data). */
export const DELETE = withRoute({ auth: "required" }, async ({ user }) => {
  await deleteAccount(user.id);
  const res = Response.json({ data: { deleted: true } });
  // Clear the session cookie(s) so the browser is signed out.
  for (const name of ["better-auth.session_token", "__Secure-better-auth.session_token", "better-auth.session_data", "__Secure-better-auth.session_data"]) {
    res.headers.append("set-cookie", `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
  }
  return res;
});
