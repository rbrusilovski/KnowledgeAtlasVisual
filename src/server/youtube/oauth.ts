/**
 * Optional Google OAuth (FEATURE_YOUTUBE_OAUTH) with the youtube.force-ssl scope so channel OWNERS can import
 * their own captions. Tokens are AES-256-GCM encrypted at rest. This scope requires Google app verification in
 * production (see README).
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { db } from "@/server/db";
import { env, features } from "@/server/env";
import { AppError } from "@/server/errors";
import { encrypt, decrypt } from "@/server/crypto";
import { redis, key } from "@/server/redis";
import * as quota from "@/server/services/quota";

const SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl";
const redirectUri = () => `${env.BETTER_AUTH_URL}/api/youtube/callback`;

function assertEnabled() {
  if (!features.youtubeOAuth) throw new AppError("NOT_FOUND", "YouTube account connection is not enabled on this server");
}

export async function authorizationUrl(userId: string): Promise<string> {
  assertEnabled();
  const state = randomBytes(24).toString("base64url");
  await redis.set(key("yt-oauth", state), userId, "EX", 600);
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID!, redirect_uri: redirectUri(), response_type: "code", scope: SCOPE, access_type: "offline", prompt: "consent", include_granted_scopes: "true", state }).toString();
  return u.toString();
}

const TokenResponse = z.object({ access_token: z.string(), expires_in: z.number(), refresh_token: z.string().optional(), scope: z.string(), id_token: z.string().optional() });

async function tokenRequest(params: Record<string, string>) {
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, ...params }), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new AppError("UPSTREAM_ERROR", `Google token exchange failed (${res.status})`);
  return TokenResponse.parse(await res.json());
}

export async function handleCallback(userId: string, code: string, state: string) {
  assertEnabled();
  const owner = await redis.getdel(key("yt-oauth", state));
  if (!owner || owner !== userId) throw new AppError("FORBIDDEN", "Invalid or expired OAuth state");
  const t = await tokenRequest({ code, grant_type: "authorization_code", redirect_uri: redirectUri() });
  // Which channels does this account own? channels.list?mine=true (1 unit).
  const r = await quota.reserve("general", 1, "interactive");
  if (!r.ok) throw new AppError("QUOTA_EXHAUSTED", "YouTube quota exhausted; try again after the Pacific-midnight reset");
  const res = await fetch("https://www.googleapis.com/youtube/v3/channels?part=id&mine=true&maxResults=50", { headers: { authorization: `Bearer ${t.access_token}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new AppError("UPSTREAM_ERROR", "Could not list your YouTube channels");
  const body = (await res.json()) as { items?: { id: string }[] };
  const channelIds = (body.items ?? []).map((i) => i.id);
  const sub = t.id_token ? (JSON.parse(Buffer.from(t.id_token.split(".")[1]!, "base64url").toString()) as { sub?: string }).sub ?? "unknown" : "unknown";
  await db.youTubeConnection.upsert({
    where: { userId },
    create: { userId, googleSub: sub, channelIds, accessTokenEnc: encrypt(t.access_token), refreshTokenEnc: t.refresh_token ? encrypt(t.refresh_token) : null, scope: t.scope, expiresAt: new Date(Date.now() + t.expires_in * 1000) },
    update: { googleSub: sub, channelIds, accessTokenEnc: encrypt(t.access_token), ...(t.refresh_token ? { refreshTokenEnc: encrypt(t.refresh_token) } : {}), scope: t.scope, expiresAt: new Date(Date.now() + t.expires_in * 1000) },
  });
  return { channelIds };
}

/** Valid access token for a connection, refreshing when within 60 s of expiry. */
export async function accessTokenFor(connectionId: string): Promise<string> {
  const c = await db.youTubeConnection.findUniqueOrThrow({ where: { id: connectionId } });
  if (c.expiresAt.getTime() - Date.now() > 60_000) return decrypt(c.accessTokenEnc);
  if (!c.refreshTokenEnc) throw new AppError("UNAUTHORIZED", "YouTube connection expired; reconnect your account");
  const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: decrypt(c.refreshTokenEnc) });
  await db.youTubeConnection.update({ where: { id: c.id }, data: { accessTokenEnc: encrypt(t.access_token), expiresAt: new Date(Date.now() + t.expires_in * 1000) } });
  return t.access_token;
}

export async function revoke(userId: string) {
  const c = await db.youTubeConnection.findUnique({ where: { userId } });
  if (!c) return;
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(decrypt(c.refreshTokenEnc ?? c.accessTokenEnc))}`, { method: "POST", signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
}
