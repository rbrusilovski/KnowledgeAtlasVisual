import type { NextRequest } from "next/server";
import { env } from "@/server/env";
import { getSessionUser } from "@/server/session";
import { errorResponse } from "@/server/http/withRoute";
import { forbidden, unauthorized } from "@/server/errors";

export const dynamic = "force-dynamic";

/** Admin-only reverse proxy to bull-board, which the worker serves on 127.0.0.1:BULL_BOARD_PORT. */
async function proxy(req: NextRequest) {
  const user = await getSessionUser(req.headers);
  if (!user) return errorResponse(unauthorized(), "admin-queues");
  if (user.role !== "ADMIN") return errorResponse(forbidden("Admin only"), "admin-queues");
  if (req.method !== "GET" && req.headers.get("origin") && new URL(req.headers.get("origin")!).origin !== new URL(env.BETTER_AUTH_URL).origin) return errorResponse(forbidden("Origin not allowed"), "admin-queues");
  const target = new URL(`${req.nextUrl.pathname}${req.nextUrl.search}`, `http://127.0.0.1:${env.BULL_BOARD_PORT}`);
  try {
    const res = await fetch(target, { method: req.method, headers: { "content-type": req.headers.get("content-type") ?? "application/json", accept: req.headers.get("accept") ?? "*/*" }, body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.text(), redirect: "manual" });
    const headers = new Headers(res.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    headers.set("content-security-policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'");
    return new Response(res.body, { status: res.status, headers });
  } catch {
    return new Response("Queue dashboard unavailable — is the worker running?", { status: 502 });
  }
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as DELETE, proxy as PATCH };
