import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { env } from "./env";

const globalForPrisma = globalThis as unknown as { __atlasPrisma?: PrismaClient };

function create(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL, max: Number(process.env.DB_POOL_MAX ?? 10) });
  return new PrismaClient({ adapter });
}

export const db: PrismaClient = globalForPrisma.__atlasPrisma ?? create();
if (env.NODE_ENV !== "production") globalForPrisma.__atlasPrisma = db;

export { Prisma } from "@/generated/prisma/client";
export type * from "@/generated/prisma/client";
