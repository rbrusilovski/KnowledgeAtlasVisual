/** Typed client fetchers. Responses follow the `{ data, meta? }` / `{ error }` envelope. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiResult<T> {
  data: T;
  meta?: Record<string, unknown>;
}

type Query = Record<string, string | number | boolean | undefined | null | (string | number)[]>;

export function qs(query?: Query): string {
  if (!query) return "";
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) {
      if (v.length) p.set(k, v.join(","));
    } else p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

export async function apiFetch<T>(
  path: string,
  init: Omit<RequestInit, "body"> & { query?: Query; body?: unknown } = {},
): Promise<ApiResult<T>> {
  const { query, body, ...rest } = init;
  const res = await fetch(`${path}${qs(query)}`, {
    ...rest,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...rest.headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const e = json?.error ?? {};
    throw new ApiError(res.status, e.code ?? "INTERNAL", e.message ?? res.statusText, e.details);
  }
  return json as ApiResult<T>;
}

export const api = {
  get: <T>(path: string, query?: Query) => apiFetch<T>(path, { method: "GET", query }).then((r) => r.data),
  getWithMeta: <T>(path: string, query?: Query) => apiFetch<T>(path, { method: "GET", query }),
  post: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: "POST", body: body ?? {} }).then((r) => r.data),
  patch: <T>(path: string, body: unknown) => apiFetch<T>(path, { method: "PATCH", body }).then((r) => r.data),
  put: <T>(path: string, body: unknown) => apiFetch<T>(path, { method: "PUT", body }).then((r) => r.data),
  del: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: "DELETE", body }).then((r) => r.data),
};
