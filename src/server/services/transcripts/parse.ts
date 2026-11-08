export interface Cue {
  start: number;
  end: number;
  text: string;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

export function normalizeText(s: string): string {
  return s
    .replace(/<\d{2}:\d{2}(?::\d{2})?[.,]\d{3}>/g, "") // inline timestamps
    .replace(/<\/?[a-z][^>]*>/gi, "") // <c>, <v Speaker>, <i>, <b>…
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\{\\[^}]*\}/g, "") // SSA-style override tags
    .replace(/\s+/g, " ")
    .trim();
}

/** "01:02:03.456" | "02:03.456" | "01:02:03,456" → seconds */
export function parseTimestamp(ts: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(ts.trim());
  if (!m) return null;
  const [, h, mi, s, ms] = m;
  return Number(h ?? 0) * 3600 + Number(mi) * 60 + Number(s) + (ms ? Number(ms.padEnd(3, "0")) / 1000 : 0);
}

const ARROW = /^\s*([\d:.,]+)\s*-->\s*([\d:.,]+)/;

function parseBlocks(text: string, isVtt: boolean): Cue[] {
  const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const cues: Cue[] = [];
  let i = 0;
  if (isVtt) {
    // Skip header + metadata until first blank line.
    while (i < lines.length && lines[i]!.trim() !== "") i++;
  }
  while (i < lines.length) {
    const line = lines[i]!;
    const m = ARROW.exec(line);
    if (!m) {
      // NOTE/STYLE/REGION blocks in VTT: skip to blank line.
      if (isVtt && /^(NOTE|STYLE|REGION)\b/.test(line)) {
        while (i < lines.length && lines[i]!.trim() !== "") i++;
      }
      i++;
      continue;
    }
    const start = parseTimestamp(m[1]!);
    const end = parseTimestamp(m[2]!);
    i++;
    const body: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "") {
      if (ARROW.test(lines[i]!)) break;
      body.push(lines[i]!);
      i++;
    }
    const t = normalizeText(body.join(" "));
    if (start !== null && end !== null && t) cues.push({ start, end: Math.max(end, start), text: t });
  }
  return dedupeRolling(cues);
}

/** YouTube auto-captions repeat the previous line as the next cue begins; collapse those. */
export function dedupeRolling(cues: Cue[]): Cue[] {
  const out: Cue[] = [];
  for (const c of cues) {
    const prev = out[out.length - 1];
    if (prev && prev.text === c.text) {
      prev.end = Math.max(prev.end, c.end);
      continue;
    }
    if (prev && c.text.startsWith(prev.text) && c.start - prev.end < 0.5) {
      const rest = c.text.slice(prev.text.length).trim();
      if (!rest) {
        prev.end = Math.max(prev.end, c.end);
        continue;
      }
      out.push({ start: c.start, end: c.end, text: rest });
      continue;
    }
    out.push({ ...c });
  }
  return out;
}

export function parseVtt(text: string): Cue[] {
  return parseBlocks(text, true);
}

export function parseSrt(text: string): Cue[] {
  return parseBlocks(text, false);
}

/** Plain text, optionally with leading timestamps ("[01:23] text", "1:23 text", "(00:01:23) text"). */
export function parsePlain(text: string): Cue[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean);
  const TS = /^[[(]?((?:\d+:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)[\])]?\s*[-–:]?\s*(.*)$/;
  const timed = lines.map((l) => {
    const m = TS.exec(l);
    return m ? { t: parseTimestamp(m[1]!), text: normalizeText(m[2]!) } : { t: null, text: normalizeText(l) };
  });
  const hasTimestamps = timed.filter((x) => x.t !== null).length >= Math.max(1, Math.floor(lines.length * 0.5));
  if (hasTimestamps) {
    const cues: Cue[] = [];
    let last = 0;
    for (const x of timed) {
      if (x.t !== null) last = x.t;
      if (!x.text) continue;
      const prev = cues[cues.length - 1];
      if (x.t === null && prev) prev.text += ` ${x.text}`;
      else cues.push({ start: last, end: last, text: x.text });
    }
    for (let i = 0; i < cues.length; i++) cues[i]!.end = cues[i + 1]?.start ?? cues[i]!.start + 5;
    return cues;
  }
  // No timestamps: split into sentences, assign synthetic ~150 wpm timing.
  const sentences = normalizeText(lines.join(" ")).match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) ?? [];
  let t = 0;
  return sentences.map((s) => {
    const dur = Math.max(1.5, (s.split(/\s+/).length / 150) * 60);
    const cue = { start: t, end: t + dur, text: s.trim() };
    t += dur;
    return cue;
  });
}

export type TranscriptFormat = "vtt" | "srt" | "txt";

export function detectFormat(text: string, filename?: string): TranscriptFormat {
  const ext = filename?.split(".").pop()?.toLowerCase();
  if (ext === "vtt" || /^﻿?WEBVTT/.test(text)) return "vtt";
  if (ext === "srt" || /^\s*\d+\s*\n\s*\d{1,2}:\d{2}:\d{2},\d{3}\s*-->/m.test(text)) return "srt";
  return "txt";
}

export function parseTranscript(text: string, filename?: string): Cue[] {
  const fmt = detectFormat(text, filename);
  return fmt === "vtt" ? parseVtt(text) : fmt === "srt" ? parseSrt(text) : parsePlain(text);
}
