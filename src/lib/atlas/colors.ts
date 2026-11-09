/** Graph encoding (spec §11). */
export const TYPE_COLORS: Record<string, string> = {
  NICHE: "#4361FF",
  SUBNICHE: "#8195FF",
  CHANNEL: "#D9DCE3",
  VIDEO: "#7C8596",
  TOPIC: "#57C7C2",
};
export const EDGE_COLOR = "rgba(160,170,190,0.12)";
export const EDGE_HIGHLIGHT = "rgba(106,130,255,0.6)";
export const ACCENT = "#4361FF";
export const FADED_ALPHA = 0.1;

/** Desaturated hues at matched lightness, legible on #0A0B0D (OKLCH-ish via HSL). */
export function categoricalColor(i: number): string {
  const golden = 137.508;
  const hue = (i * golden + 210) % 360;
  return hslToHex(hue, 0.42, 0.62);
}

/** WebGL color parsing is reliable for hex/rgba; convert HSL up front. */
export function hslToHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (x: number) => Math.round(x * 255).toString(16).padStart(2, "0");
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
}

const NICHE_ORDER = ["technology", "science-education", "finance-business", "gaming", "health-fitness", "food", "creative", "lifestyle", "diy-trades", "entertainment", "sports"];
export function nicheColor(slug: string | undefined | null): string {
  if (!slug) return "#8A90A0";
  const i = NICHE_ORDER.indexOf(slug);
  return categoricalColor(i >= 0 ? i : hash(slug) % 40);
}
export function communityColor(id: number | null | undefined): string {
  return id === null || id === undefined ? "#8A90A0" : categoricalColor(id);
}

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Convert any css color + alpha to rgba() (sigma accepts rgba strings). */
export function withAlpha(color: string, alpha: number): string {
  if (color.startsWith("#")) {
    const n = parseInt(color.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }
  if (color.startsWith("rgba(")) return color.replace(/,\s*[\d.]+\)$/, `,${alpha})`);
  return color;
}
