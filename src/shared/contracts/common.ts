import { z } from "zod";

export const ErrorCode = z.enum([
  "VALIDATION_ERROR",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "QUOTA_EXHAUSTED",
  "NEEDS_CONFIRMATION",
  "UPSTREAM_ERROR",
  "INTERNAL",
]);

export const ErrorEnvelope = z.object({ error: z.object({ code: ErrorCode, message: z.string(), details: z.unknown().optional() }) });

export const Limit = z.coerce.number().int().min(1).max(100).default(25);
export const Cursor = z.string().max(500).optional();

/** Comma-separated list or repeated query param → string[] */
export const csv = <T extends z.ZodType<unknown, string>>(item: T) =>
  z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => (v === undefined ? undefined : (Array.isArray(v) ? v : v.split(",")).map((s) => s.trim()).filter(Boolean)))
    .pipe(z.array(item).optional());

export const boolish = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === true || v === "true" || v === "1"));

export const NodeId = z.string().regex(/^(niche|subniche|channel|video|topic):[\p{L}\p{N}._-]{1,80}$/u, "Invalid node id");

export const IdParam = z.object({ id: z.string().min(1).max(100) });
