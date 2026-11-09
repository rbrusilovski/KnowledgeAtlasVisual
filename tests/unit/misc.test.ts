import { describe, expect, it } from "vitest";
import { encodeCursor, decodeCursor } from "@/server/http/cursor";
import { encrypt, decrypt } from "@/server/crypto";
import { parseIsoDuration } from "@/server/youtube/schemas";

describe("cursor encoding", () => {
  it("round-trips and is opaque", () => {
    const c = encodeCursor({ o: 50, id: "abc" });
    expect(c).not.toContain("abc");
    expect(decodeCursor(c)).toEqual({ o: 50, id: "abc" });
  });
  it("rejects garbage", () => {
    expect(decodeCursor("not-base64!!")).toBeNull();
    expect(decodeCursor(Buffer.from("[1,2]").toString("base64url"))).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
  });
});

describe("AES-256-GCM encryption", () => {
  it("round-trips with a key-id prefix and random IV", () => {
    const a = encrypt("ya29.secret-token");
    const b = encrypt("ya29.secret-token");
    expect(a).not.toEqual(b);
    expect(a.split(":")[0]).toBe("k1");
    expect(decrypt(a)).toBe("ya29.secret-token");
  });
  it("detects tampering", () => {
    const parts = encrypt("hello").split(":");
    parts[3] = Buffer.from("jello").toString("base64url");
    expect(() => decrypt(parts.join(":"))).toThrow();
  });
});

describe("ISO 8601 durations", () => {
  it.each([
    ["PT1H2M3S", 3723],
    ["PT45S", 45],
    ["PT10M", 600],
    ["P1DT1S", 86401],
    ["PT0S", 0],
  ])("%s", (iso, sec) => expect(parseIsoDuration(iso)).toBe(sec));
  it("returns undefined for junk", () => expect(parseIsoDuration("1:23")).toBeUndefined());
});

describe("local embedding runtime", () => {
  it("@huggingface/transformers and its ONNX runtime resolve (guards against phantom-dependency breakage)", async () => {
    const tf = await import("@huggingface/transformers");
    expect(typeof tf.pipeline).toBe("function");
  }, 60_000);
});
