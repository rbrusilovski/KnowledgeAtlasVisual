import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { db } from "./db";
import { env, features } from "./env";
import { baseLogger } from "./logger";

export const auth = betterAuth({
  appName: "Atlas",
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  database: prismaAdapter(db, { provider: "postgresql" }),
  trustedOrigins: [env.BETTER_AUTH_URL],
  emailAndPassword: { enabled: true, autoSignIn: true, minPasswordLength: 8, maxPasswordLength: 128 },
  socialProviders: {
    ...(features.github
      ? { github: { clientId: env.GITHUB_CLIENT_ID!, clientSecret: env.GITHUB_CLIENT_SECRET! } }
      : {}),
    ...(features.google
      ? { google: { clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET! } }
      : {}),
  },
  user: {
    additionalFields: {
      role: { type: "string", input: false, defaultValue: "USER", required: false },
      reducedMotion: { type: "boolean", input: false, defaultValue: false, required: false },
      defaultLayout: { type: "string", input: false, defaultValue: "global", required: false },
    },
  },
  // No cookie cache: revoking a session or deleting an account must take effect immediately.
  session: { cookieCache: { enabled: false } },
  rateLimit: { enabled: env.NODE_ENV === "production", window: 60, max: 30 },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          const role = env.ADMIN_EMAILS.includes(user.email.toLowerCase()) ? "ADMIN" : "USER";
          return { data: { ...user, role } };
        },
        after: async (user) => {
          // First workspace is auto-created on signup (spec §9).
          await db.workspace.create({
            data: {
              ownerId: user.id,
              name: "My atlas",
              collections: { create: { name: "Favorites", color: "#4361FF", icon: "star", sortOrder: 0 } },
            },
          });
          baseLogger.info({ userId: user.id }, "user signed up; default workspace created");
        },
      },
    },
  },
  plugins: [nextCookies()],
});

export type Auth = typeof auth;
