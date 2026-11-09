import { Fragment } from "react";

/** Safely renders text containing only <mark>…</mark> highlights (from ts_headline). Everything else is text. */
export function Highlight({ text, className }: { text: string | null | undefined; className?: string }) {
  if (!text) return null;
  const segments: { text: string; marked: boolean }[] = [];
  let marked = false;
  for (const p of text.split(/(<mark>|<\/mark>)/)) {
    if (p === "<mark>") marked = true;
    else if (p === "</mark>") marked = false;
    else if (p) segments.push({ text: p, marked });
  }
  return (
    <span className={className}>
      {segments.map((seg, i) =>
        seg.marked ? (
          <mark key={i} className="rounded-[3px] bg-accent-500/25 px-0.5 text-text-1">
            {seg.text}
          </mark>
        ) : (
          <Fragment key={i}>{seg.text}</Fragment>
        ),
      )}
    </span>
  );
}

/** Linkify URLs in plain text without innerHTML. */
export function Linkified({ text, className }: { text: string; className?: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"')]+)/g);
  return (
    <span className={className}>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a key={i} href={p} target="_blank" rel="noopener noreferrer nofollow ugc" className="text-accent-300 underline-offset-2 hover:underline">
            {p}
          </a>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </span>
  );
}
