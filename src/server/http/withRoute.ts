import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z, ZodError, type ZodType } from "zod";
import { env } from "../env";
import { AppError, unauthorized, forbidden } from "../errors";
import { baseLogger, requestContext } from "../logger";
import { enforceRateLimit, type RateLimitSpec } from "./rateLimit";
import { getSessionUser, type SessionUser } from "../session";

type AuthMode = "none" | "optional" | "required" | "admin";

interface RouteOptions<Q extends ZodType | undefined, B extends ZodType | undefined, P extends ZodType | undefined> {
  auth?: AuthMode;
  query?: Q;
  body?: B;
  params?: P;
  /** Extra limiter on top of the global anon/user limit. `false` disables the global one too (SSE). */
  rateLimit?: RateLimitSpec | RateLimitSpec[] | false;
}

type Infer<T> = T extends ZodType ? z.infer<T> : undefined;

export interface RouteCtx<Q, B, P, U> {
  req: NextRequest;
  query: Q;
  body: B;
  params: P;
  user: U;
  requestId: string;
  ip: string;
}

export interface Envelope<T> {
  data: T;
  meta?: Record<string, unknown>;
}

/** Return this from a handler to attach `meta` to the success envelope. */
export class WithMeta<T> {
  constructor(
    readonly data: T,
    readonly meta: Record<string, unknown>,
    readonly status = 200,
  ) {}
}

export const withMeta = <T>(data: T, meta: Record<string, unknown>, status = 200) => new WithMeta(data, meta, status);

type UserFor<A extends AuthMode | undefined> = A extends "required" | "admin" ? SessionUser : SessionUser | null;

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  return (fwd?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "127.0.0.1").slice(0, 64);
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function checkOrigin(req: NextRequest) {
  if (!MUTATING.has(req.method)) return;
  const origin = req.headers.get("origin");
  if (!origin) {
    // Non-browser clients (curl, tests) send no Origin; browsers always do on cross-site mutations.
    const site = req.headers.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") throw forbidden("Cross-site request rejected");
    return;
  }
  const allowed = new Set([new URL(env.BETTER_AUTH_URL).origin, req.nextUrl.origin]);
  if (!allowed.has(origin)) throw forbidden("Origin not allowed");
}

/** BigInt → string so JSON.stringify never throws on Prisma BigInt columns. */
export function jsonReplacer(_k: string, v: unknown) {
  return typeof v === "bigint" ? Number(v) : v;
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body, jsonReplacer), { ...init, headers });
}

export function errorResponse(err: unknown, requestId: string): Response {
  if (err instanceof AppError) {
    return json(
      { error: { code: err.code, message: err.message, details: err.details } },
      { status: err.status, headers: { ...err.headers, "x-request-id": requestId } },
    );
  }
  if (err instanceof ZodError) {
    return json(
      { error: { code: "VALIDATION_ERROR", message: "Invalid request", details: z.flattenError(err) } },
      { status: 400, headers: { "x-request-id": requestId } },
    );
  }
  baseLogger.error({ err, requestId }, "unhandled route error");
  return json(
    { error: { code: "INTERNAL", message: "Something went wrong" } },
    { status: 500, headers: { "x-request-id": requestId } },
  );
}

async function readBody(req: NextRequest): Promise<unknown> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const text = await req.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new AppError("VALIDATION_ERROR", "Malformed JSON body");
    }
  }
  if (ct.includes("multipart/form-data") || ct.includes("application/x-www-form-urlencoded")) {
    const fd = await req.formData();
    const out: Record<string, unknown> = {};
    for (const [k, v] of fd.entries()) out[k] = typeof v === "string" ? v : await v.text();
    return out;
  }
  const text = await req.text();
  return text ? { text } : {};
}

function queryObject(req: NextRequest): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const k of new Set(req.nextUrl.searchParams.keys())) {
    const all = req.nextUrl.searchParams.getAll(k);
    out[k] = all.length > 1 ? all : all[0]!;
  }
  return out;
}

export function withRoute<
  Q extends ZodType | undefined = undefined,
  B extends ZodType | undefined = undefined,
  P extends ZodType | undefined = undefined,
  A extends AuthMode | undefined = undefined,
>(
  opts: RouteOptions<Q, B, P> & { auth?: A },
  handler: (ctx: RouteCtx<Infer<Q>, Infer<B>, Infer<P>, UserFor<A>>) => Promise<unknown>,
) {
  return async (req: NextRequest, routeCtx: { params: Promise<Record<string, string | string[]>> }) => {
    const requestId = req.headers.get("x-request-id") ?? randomUUID();
    const ip = clientIp(req);
    try {
      checkOrigin(req);
      const mode: AuthMode = opts.auth ?? "none";
      const user = mode === "none" && opts.rateLimit === false ? null : await getSessionUser(req.headers);
      if ((mode === "required" || mode === "admin") && !user) throw unauthorized();
      if (mode === "admin" && user?.role !== "ADMIN") throw forbidden("Admin only");

      if (opts.rateLimit !== false) {
        await enforceRateLimit(
          user
            ? { name: "api-user", limit: env.RATE_LIMIT_USER_PER_MIN, windowSec: 60 }
            : { name: "api-anon", limit: env.RATE_LIMIT_ANON_PER_MIN, windowSec: 60 },
          user ? `u:${user.id}` : `ip:${ip}`,
        );
        const extra = opts.rateLimit ? (Array.isArray(opts.rateLimit) ? opts.rateLimit : [opts.rateLimit]) : [];
        for (const spec of extra) await enforceRateLimit(spec, user ? `u:${user.id}` : `ip:${ip}`);
      }

      const rawParams = routeCtx?.params ? await routeCtx.params : {};
      const params = opts.params ? opts.params.parse(rawParams) : rawParams;
      const query = opts.query ? opts.query.parse(queryObject(req)) : undefined;
      const body = opts.body ? opts.body.parse(await readBody(req)) : undefined;

      const result = await requestContext.run({ requestId, userId: user?.id }, () =>
        handler({
          req,
          query: query as Infer<Q>,
          body: body as Infer<B>,
          params: params as Infer<P>,
          user: user as UserFor<A>,
          requestId,
          ip,
        }),
      );

      // Personal or agent-scoped responses must never be stored by shared caches or the browser cache (D10).
      const personal = Boolean(user) || req.headers.has("authorization");
      if (result instanceof Response) {
        result.headers.set("x-request-id", requestId);
        if (personal && !result.headers.has("cache-control")) result.headers.set("cache-control", "private, no-store");
        return result;
      }
      const headers: Record<string, string> = { "x-request-id": requestId, ...(personal ? { "cache-control": "private, no-store" } : {}) };
      if (result instanceof WithMeta) {
        return json({ data: result.data, meta: result.meta }, { status: result.status, headers });
      }
      return json({ data: result ?? null }, { headers });
    } catch (err) {
      const res = errorResponse(err, requestId);
      res.headers.set("cache-control", "no-store");
      return res;
    }
  };
}
