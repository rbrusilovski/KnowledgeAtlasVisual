/**
 * Channel input resolver (spec §7.1). Accepts UC… IDs, @handle, youtube.com/@handle, /channel/UC…,
 * /user/name, /c/custom, bare custom paths, video URLs (watch, youtu.be, shorts, live, embed).
 * Cheap paths first; anything requiring search.list returns `needsConfirmation` with the cost.
 */
export type ParsedInput =
  | { kind: "id"; value: string }
  | { kind: "handle"; value: string }
  | { kind: "username"; value: string }
  | { kind: "custom"; value: string }
  | { kind: "video"; value: string }
  | { kind: "ambiguous"; value: string }
  | { kind: "invalid"; reason: string };

const UC = /^UC[A-Za-z0-9_-]{22}$/;
const VID = /^[A-Za-z0-9_-]{11}$/;
const HANDLE = /^[\p{L}\p{N}._-]{3,30}$/u;
const YT_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"]);
const RESERVED = new Set(["watch", "channel", "user", "c", "shorts", "live", "embed", "playlist", "results", "feed", "gaming", "premium", "about", "t", "hashtag", "post"]);

export function parseChannelInput(input: string): ParsedInput {
  const s = input.trim();
  if (!s) return { kind: "invalid", reason: "Empty input" };
  if (s.length > 300) return { kind: "invalid", reason: "Input too long" };
  if (UC.test(s)) return { kind: "id", value: s };
  if (s.startsWith("@")) {
    const h = decodeURIComponent(s.slice(1)).replace(/\/.*$/, "");
    return HANDLE.test(h) ? { kind: "handle", value: h.toLowerCase() } : { kind: "invalid", reason: "Invalid handle" };
  }

  let url: URL | null = null;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    url = null;
  }
  const host = url?.hostname.toLowerCase();
  if (url && host === "youtu.be") {
    const id = url.pathname.split("/").filter(Boolean)[0] ?? "";
    return VID.test(id) ? { kind: "video", value: id } : { kind: "invalid", reason: "Invalid youtu.be link" };
  }
  if (url && host && YT_HOSTS.has(host)) {
    const parts = url.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
    const [first, second] = parts;
    if (!first) {
      const v = url.searchParams.get("v");
      return v && VID.test(v) ? { kind: "video", value: v } : { kind: "invalid", reason: "No channel in URL" };
    }
    if (first === "watch") {
      const v = url.searchParams.get("v") ?? "";
      return VID.test(v) ? { kind: "video", value: v } : { kind: "invalid", reason: "Invalid video URL" };
    }
    if ((first === "shorts" || first === "live" || first === "embed") && second) {
      return VID.test(second) ? { kind: "video", value: second } : { kind: "invalid", reason: "Invalid video URL" };
    }
    if (first.startsWith("@")) {
      const h = first.slice(1);
      return HANDLE.test(h) ? { kind: "handle", value: h.toLowerCase() } : { kind: "invalid", reason: "Invalid handle" };
    }
    if (first === "channel" && second) return UC.test(second) ? { kind: "id", value: second } : { kind: "invalid", reason: "Invalid channel ID" };
    if (first === "user" && second) return { kind: "username", value: second };
    if (first === "c" && second) return { kind: "custom", value: second };
    if (!RESERVED.has(first)) return { kind: "custom", value: first };
    return { kind: "invalid", reason: "Unsupported YouTube URL" };
  }
  if (url && host && host.includes(".") && !/^[\p{L}\p{N}._-]+$/u.test(s)) {
    return { kind: "invalid", reason: "Not a YouTube URL" };
  }
  // Bare word: try as a handle first (1 unit), then legacy username.
  if (HANDLE.test(s)) return { kind: "ambiguous", value: s };
  return { kind: "invalid", reason: "Unrecognized channel input" };
}

/** Alias key used in ChannelAlias.value and the Redis resolution cache. */
export function aliasKey(p: ParsedInput): string | null {
  switch (p.kind) {
    case "id":
      return `id:${p.value}`;
    case "handle":
      return `handle:${p.value.toLowerCase()}`;
    case "username":
      return `user:${p.value.toLowerCase()}`;
    case "custom":
      return `custom:${p.value.toLowerCase()}`;
    case "ambiguous":
      return `handle:${p.value.toLowerCase()}`;
    default:
      return null;
  }
}
