import { auth } from "./auth";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  image: string | null;
  role: "USER" | "ADMIN";
}

export async function getSessionUser(headers: Headers): Promise<SessionUser | null> {
  const session = await auth.api.getSession({ headers }).catch(() => null);
  if (!session) return null;
  const u = session.user as typeof session.user & { role?: string };
  return { id: u.id, email: u.email, name: u.name, image: u.image ?? null, role: u.role === "ADMIN" ? "ADMIN" : "USER" };
}
