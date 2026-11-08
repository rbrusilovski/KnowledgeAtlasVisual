import { describe, expect, it } from "vitest";
import { parseVtt, parseSrt, parsePlain, parseTranscript, detectFormat, chunkCues, estimateTokens, timestampUrl, normalizeText } from "@/server/services/transcripts";

const VTT = `WEBVTT
Kind: captions
Language: en

NOTE this is a comment
spanning lines

1
00:00:00.500 --> 00:00:04.000 align:start position:0%
Hello <c>and</c> welcome &amp; enjoy

00:00:04.000 --> 00:00:07.250
<v Speaker>Today we look at sourdough.</v>

3
01:02:03.004 --> 01:02:05.000
Later cue`;

describe("VTT parsing", () => {
  it("parses cues, strips tags/entities, skips NOTE blocks, handles optional identifiers", () => {
    const cues = parseVtt(VTT);
    expect(cues).toEqual([
      { start: 0.5, end: 4, text: "Hello and welcome & enjoy" },
      { start: 4, end: 7.25, text: "Today we look at sourdough." },
      { start: 3723.004, end: 3725, text: "Later cue" },
    ]);
  });
  it("collapses YouTube rolling auto-caption duplicates", () => {
    const vtt = `WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhello there\n\n00:00:02.000 --> 00:00:03.000\nhello there\n\n00:00:03.000 --> 00:00:04.000\nhello there general kenobi\n`;
    expect(parseVtt(vtt)).toEqual([
      { start: 1, end: 3, text: "hello there" },
      { start: 3, end: 4, text: "general kenobi" },
    ]);
  });
  it("tolerates BOM and CRLF", () => {
    expect(parseVtt("﻿WEBVTT\r\n\r\n00:01.000 --> 00:02.000\r\nhi\r\n")).toEqual([{ start: 1, end: 2, text: "hi" }]);
  });
});

describe("SRT parsing", () => {
  it("parses comma millisecond timestamps and multi-line cues", () => {
    const srt = `1\n00:00:01,000 --> 00:00:02,500\nFirst line\nsecond line\n\n2\n00:00:03,000 --> 00:00:04,000\n<i>Italic</i>\n`;
    expect(parseSrt(srt)).toEqual([
      { start: 1, end: 2.5, text: "First line second line" },
      { start: 3, end: 4, text: "Italic" },
    ]);
  });
});

describe("plain text parsing", () => {
  it("uses leading timestamps when present", () => {
    const cues = parsePlain("[00:00] intro\n[01:30] main part\ncontinues here\n(1:02:03) late");
    expect(cues.map((c) => [c.start, c.text])).toEqual([
      [0, "intro"],
      [90, "main part continues here"],
      [3723, "late"],
    ]);
    expect(cues[0]!.end).toBe(90);
  });
  it("synthesizes timing from sentences without timestamps", () => {
    const cues = parsePlain("One sentence here. Another one follows! And a third?");
    expect(cues).toHaveLength(3);
    expect(cues[1]!.start).toBeGreaterThan(0);
  });
});

describe("format detection", () => {
  it("detects by content and extension", () => {
    expect(detectFormat("WEBVTT\n\n")).toBe("vtt");
    expect(detectFormat("1\n00:00:01,000 --> 00:00:02,000\nx")).toBe("srt");
    expect(detectFormat("hello", "x.srt")).toBe("srt");
    expect(detectFormat("hello")).toBe("txt");
    expect(parseTranscript("1\n00:00:01,000 --> 00:00:02,000\nx\n")).toHaveLength(1);
  });
  it("normalizes whitespace and inline timestamps", () => {
    expect(normalizeText("  a <00:00:01.000>b\n\n c  ")).toBe("a b c");
  });
});

describe("chunking", () => {
  const cues = Array.from({ length: 200 }, (_, i) => ({ start: i * 5, end: i * 5 + 5, text: "word ".repeat(12).trim() }));
  const chunks = chunkCues(cues);
  it("produces ~250–400 token chunks with timestamps", () => {
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks.slice(0, -1)) {
      const t = estimateTokens(c.text);
      expect(t).toBeGreaterThanOrEqual(250);
      expect(t).toBeLessThanOrEqual(400);
    }
    expect(chunks[0]!.startSec).toBe(0);
    expect(chunks.at(-1)!.endSec).toBe(1000);
  });
  it("overlaps consecutive chunks by ~15%", () => {
    const a = chunks[0]!;
    const b = chunks[1]!;
    expect(b.startSec).toBeLessThan(a.endSec);
    const overlapSec = a.endSec - b.startSec;
    expect(overlapSec / (a.endSec - a.startSec)).toBeGreaterThan(0.08);
    expect(overlapSec / (a.endSec - a.startSec)).toBeLessThan(0.3);
  });
  it("indexes sequentially and handles a single oversized cue", () => {
    expect(chunks.map((c) => c.idx)).toEqual(chunks.map((_, i) => i));
    const big = chunkCues([{ start: 0, end: 9, text: "x ".repeat(900) }]);
    expect(big).toHaveLength(1);
  });
  it("builds YouTube deep links with floored seconds", () => {
    expect(timestampUrl("dQw4w9WgXcQ", 83.9)).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=83s");
  });
});
