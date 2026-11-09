import { AsyncLocalStorage } from "node:async_hooks";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { env } from "./env";

const globalForPrisma = globalThis as unknown as { __atlasPrisma?: PrismaClient };

/**
 * Read-only execution scope. Code run inside `readOnly(fn)` (e.g. Claude's inspection tools) cannot mutate the
 * database: every Prisma write operation and every `$executeRaw*` throws `ReadOnlyViolation`. Raw `$queryRaw` reads
 * are allowed; a raw query that starts with a write keyword is refused as well.
 */
const readOnlyScope = new AsyncLocalStorage<{ label: string }>();

export class ReadOnlyViolation extends Error {
  constructor(label: string, operation: string, model?: string) {
    super(`Write operation ${model ? `${model}.` : ""}${operation} attempted inside read-only scope "${label}"`);
    this.name = "ReadOnlyViolation";
  }
}

const WRITE_OPS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
  "$executeRaw",
  "$executeRawUnsafe",
]);
const RAW_WRITE = /^\s*(insert|update|delete|merge|truncate|alter|create|drop|grant|revoke|copy|call|do|vacuum|reindex|cluster|refresh|lock|select\s[^;]*\bfor\s+(update|share)\b)/i;

function rawSql(args: unknown): string {
  if (typeof args === "string") return args;
  if (Array.isArray(args) && typeof args[0] === "string") return args[0];
  const a = args as { strings?: readonly string[]; sql?: string } | undefined;
  if (a?.sql) return a.sql;
  if (a?.strings) return a.strings.join("?");
  return "";
}

export function readOnly<T>(label: string, fn: () => Promise<T>): Promise<T> {
  // Await *inside* the scope: Prisma model calls return lazy promises that only execute on `.then`, so returning one
  // unawaited would run the query after the async context has exited.
  return readOnlyScope.run({ label }, async () => await fn());
}

export function inReadOnlyScope(): boolean {
  return readOnlyScope.getStore() !== undefined;
}

function create(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL, max: Number(process.env.DB_POOL_MAX ?? 10) });
  const base = new PrismaClient({ adapter });
  const guarded = base.$extends({
    name: "atlas-read-only-guard",
    query: {
      async $allOperations({ model, operation, args, query }) {
        const scope = readOnlyScope.getStore();
        if (scope) {
          // `SET LOCAL <setting> = …` (e.g. hnsw.ef_search inside a KNN transaction) changes no data and stays allowed.
          const setLocal = (operation === "$executeRaw" || operation === "$executeRawUnsafe") && /^\s*set\s+local\s+[a-z_.]+\s*=\s*[\w.]+\s*;?\s*$/i.test(rawSql(args));
          if (WRITE_OPS.has(operation) && !setLocal) throw new ReadOnlyViolation(scope.label, operation, model);
          if ((operation === "$queryRaw" || operation === "$queryRawUnsafe") && RAW_WRITE.test(rawSql(args))) throw new ReadOnlyViolation(scope.label, operation);
        }
        return query(args);
      },
    },
  });
  // The extension only adds behaviour; the client surface is unchanged.
  return guarded as unknown as PrismaClient;
}

export const db: PrismaClient = globalForPrisma.__atlasPrisma ?? create();
if (env.NODE_ENV !== "production") globalForPrisma.__atlasPrisma = db;

export { Prisma } from "@/generated/prisma/client";
export type * from "@/generated/prisma/client";
