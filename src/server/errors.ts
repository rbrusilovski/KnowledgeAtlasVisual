export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "QUOTA_EXHAUSTED"
  | "NEEDS_CONFIRMATION"
  | "UPSTREAM_ERROR"
  | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  QUOTA_EXHAUSTED: 429,
  NEEDS_CONFIRMATION: 409,
  UPSTREAM_ERROR: 502,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "AppError";
    this.status = STATUS[code];
  }
}

export const notFound = (what = "Resource") => new AppError("NOT_FOUND", `${what} not found`);
export const forbidden = (msg = "You do not have access to this resource") => new AppError("FORBIDDEN", msg);
export const unauthorized = () => new AppError("UNAUTHORIZED", "Sign in required");
