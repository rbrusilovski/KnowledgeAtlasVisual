import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";

/** Deterministic generated SVG avatars/thumbnails for the fixture dataset (no external images). */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/placeholder/[kind]/[seed]">) {
  const { kind, seed } = await ctx.params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(seed) || (kind !== "avatar" && kind !== "thumb")) {
    return new Response("Not found", { status: 404 });
  }
  const h = createHash("sha256").update(seed).digest();
  const hue = (h[0]! / 255) * 360;
  const hue2 = (hue + 40 + (h[1]! / 255) * 80) % 360;
  const c1 = `hsl(${hue.toFixed(0)} 45% 46%)`;
  const c2 = `hsl(${hue2.toFixed(0)} 50% 28%)`;
  const shapes = Array.from({ length: 5 }, (_, i) => {
    const x = (h[2 + i * 3]! / 255) * 100;
    const y = (h[3 + i * 3]! / 255) * 100;
    const r = 8 + (h[4 + i * 3]! / 255) * 26;
    return `<circle cx="${x.toFixed(1)}%" cy="${y.toFixed(1)}%" r="${r.toFixed(1)}" fill="white" fill-opacity="${(0.05 + (i % 3) * 0.05).toFixed(2)}"/>`;
  }).join("");
  const [w, hgt] = kind === "avatar" ? [128, 128] : [320, 180];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${hgt}" viewBox="0 0 ${w} ${hgt}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
<rect width="100%" height="100%" fill="url(#g)"/>${shapes}
${kind === "thumb" ? `<rect x="${w - 46}" y="${hgt - 22}" width="38" height="14" rx="3" fill="black" fill-opacity="0.55"/>` : ""}
</svg>`;
  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml",
      "cache-control": "public, max-age=31536000, immutable",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}
