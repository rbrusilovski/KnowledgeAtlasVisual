const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
export const fmtCompact = (n: number | null | undefined) => (n === null || n === undefined ? "—" : compact.format(n));
export const fmtInt = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toLocaleString("en"));

export function fmtDuration(sec: number | null | undefined) {
  if (sec === null || sec === undefined) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
export function fmtRelative(iso: string | Date | null | undefined) {
  if (!iso) return "never";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const diff = (d.getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const [v, u] =
    abs < 60 ? [diff, "second"] : abs < 3600 ? [diff / 60, "minute"] : abs < 86400 ? [diff / 3600, "hour"] : abs < 86400 * 30 ? [diff / 86400, "day"] : abs < 86400 * 365 ? [diff / (86400 * 30), "month"] : [diff / (86400 * 365), "year"];
  return rtf.format(Math.round(v), u as Intl.RelativeTimeFormatUnit);
}

export const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric" }) : "—");
export const fmtTimestamp = (sec: number) => fmtDuration(sec);
