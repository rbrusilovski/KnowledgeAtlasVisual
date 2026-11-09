import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import { resetRefusal } from "../../scripts/lib/reset-guard";
import { decryptStream, encryptStream, MAGIC } from "../../scripts/lib/pg-tools";
import { generateToken, hashToken, TOKEN_PREFIX } from "@/server/services/agent";
import { EDGE_PROVENANCE } from "@/server/services/graph";

const LOCAL = "postgresql://atlas:atlas@localhost:5432/atlas";

describe("db:reset guard (D3)", () => {
  it("allows a confirmed local development reset", () => {
    expect(resetRefusal({ env: { DATABASE_URL: LOCAL }, argv: ["--yes"] })).toBeNull();
    expect(resetRefusal({ env: { DATABASE_URL: LOCAL, ATLAS_RESET_CONFIRM: "1" }, argv: [] })).toBeNull();
  });
  it("requires confirmation", () => {
    expect(resetRefusal({ env: { DATABASE_URL: LOCAL }, argv: [] })).toMatch(/--yes/);
  });
  it("refuses production, live mode and remote hosts", () => {
    expect(resetRefusal({ env: { DATABASE_URL: LOCAL, NODE_ENV: "production" }, argv: ["--yes"] })).toMatch(/production/);
    expect(resetRefusal({ env: { DATABASE_URL: LOCAL, ATLAS_ENV: "production" }, argv: ["--yes"] })).toMatch(/production/);
    expect(resetRefusal({ env: { DATABASE_URL: LOCAL, YOUTUBE_MODE: "live" }, argv: ["--yes"] })).toMatch(/live/);
    expect(resetRefusal({ env: { DATABASE_URL: "postgresql://u:p@db.example.com:5432/atlas" }, argv: ["--yes"] })).toMatch(/non-local/);
  });
  it("allows an explicitly acknowledged remote dev database, but never in production", () => {
    const remote = "postgresql://u:p@devbox.internal:5432/atlas";
    expect(resetRefusal({ env: { DATABASE_URL: remote, ATLAS_ALLOW_REMOTE_RESET: "1" }, argv: ["--yes"] })).toBeNull();
    expect(resetRefusal({ env: { DATABASE_URL: remote, ATLAS_ALLOW_REMOTE_RESET: "1", NODE_ENV: "production" }, argv: ["--yes"] })).toMatch(/production/);
  });
});

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of stream as AsyncIterable<Buffer>) parts.push(Buffer.from(c));
  return Buffer.concat(parts);
}
const chunked = (b: Buffer, size: number) => Readable.from(Array.from({ length: Math.ceil(b.length / size) }, (_, i) => b.subarray(i * size, (i + 1) * size)));

describe("backup encryption (D2)", () => {
  const key = randomBytes(32);
  it("round-trips across arbitrary chunk boundaries", async () => {
    const plain = randomBytes(200_003);
    const enc = await collect(chunked(plain, 7_777).pipe(encryptStream(key, "b1")));
    expect(enc.subarray(0, MAGIC.length).equals(MAGIC)).toBe(true);
    expect(enc.includes(plain.subarray(0, 64))).toBe(false);
    for (const size of [1, 13, 4_096, enc.length]) expect((await collect(chunked(enc, size).pipe(decryptStream(key)))).equals(plain)).toBe(true);
  });
  it("encrypts an empty dump", async () => {
    const enc = await collect(Readable.from([]).pipe(encryptStream(key, "b1")));
    expect((await collect(Readable.from([enc]).pipe(decryptStream(key)))).length).toBe(0);
  });
  it("rejects tampering, truncation and the wrong key", async () => {
    const enc = await collect(Readable.from([randomBytes(5_000)]).pipe(encryptStream(key, "b1")));
    const tampered = Buffer.from(enc);
    tampered[100] = tampered[100]! ^ 0xff;
    await expect(collect(Readable.from([tampered]).pipe(decryptStream(key)))).rejects.toThrow();
    await expect(collect(Readable.from([enc.subarray(0, enc.length - 5)]).pipe(decryptStream(key)))).rejects.toThrow();
    await expect(collect(Readable.from([enc]).pipe(decryptStream(randomBytes(32))))).rejects.toThrow();
    await expect(collect(Readable.from([Buffer.from("plain pg_dump output")]).pipe(decryptStream(key)))).rejects.toThrow(/magic|Truncated/);
  });
});

describe("agent tokens (D7)", () => {
  it("are high-entropy, prefixed and hashed with SHA-256", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    expect(a.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(a.length).toBeGreaterThanOrEqual(TOKEN_PREFIX.length + 43);
    expect(hashToken(a)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashToken(a)).toBe(hashToken(a));
  });
});

describe("edge provenance (D8)", () => {
  it("labels only YouTube-stated relations as FACT", () => {
    const facts = Object.entries(EDGE_PROVENANCE).filter(([, p]) => p.label === "FACT").map(([k]) => k).sort();
    expect(facts).toEqual(["FEATURED", "PUBLISHED"]);
    for (const p of Object.values(EDGE_PROVENANCE)) expect(p.label === "FACT").toBe(p.basis === "youtube-fact");
  });
});
