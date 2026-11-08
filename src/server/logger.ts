import { AsyncLocalStorage } from "node:async_hooks";
import pino, { type Logger } from "pino";
import { env } from "./env";

export const baseLogger: Logger = pino({
  level: env.NODE_ENV === "test" ? "silent" : env.LOG_LEVEL,
  base: { svc: process.env.ATLAS_PROCESS ?? "web" },
  redact: { paths: ["*.apiKey", "*.key", "*.token", "*.password", "*.accessToken", "*.refreshToken"], censor: "[redacted]" },
});

interface RequestContext {
  requestId: string;
  userId?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/** Logger bound to the current request/job context (request ID propagates into jobs). */
export function log(): Logger {
  const ctx = requestContext.getStore();
  return ctx ? baseLogger.child({ requestId: ctx.requestId, userId: ctx.userId }) : baseLogger;
}

export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}
