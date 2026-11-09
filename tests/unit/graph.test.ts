import { describe, expect, it } from "vitest";
import { weightedJaccard, npmi, topK, canonical, edgeId, parseNodeId } from "@/server/services/graph";

describe("graph math", () => {
  it("weighted Jaccard = Σmin/Σmax and reports shared keys by strength", () => {
    const a = new Map([["x", 1], ["y", 0.5], ["z", 0.2]]);
    const b = new Map([["x", 0.5], ["y", 0.5], ["w", 1]]);
    const j = weightedJaccard(a, b);
    expect(j.score).toBeCloseTo((0.5 + 0.5) / (1 + 0.5 + 0.2 + 1));
    expect(j.shared).toEqual(["x", "y"]);
    expect(weightedJaccard(new Map(), new Map()).score).toBe(0);
  });

  it("NPMI is 1 for perfect co-occurrence, ~0 for independence, negative when rarer than chance", () => {
    expect(npmi(10, 10, 10, 100)).toBeCloseTo(1);
    expect(npmi(1, 10, 10, 100)).toBeCloseTo(0, 5);
    expect(npmi(1, 50, 50, 100)).toBeLessThan(0);
    expect(npmi(0, 1, 1, 10)).toBe(-1);
  });

  it("top-k prunes by score with deterministic tie-breaks", () => {
    const items = [{ id: "b", s: 1 }, { id: "a", s: 1 }, { id: "c", s: 3 }, { id: "d", s: 0.1 }];
    expect(topK(items, 3, (x) => x.s, (x) => x.id).map((x) => x.id)).toEqual(["c", "a", "b"]);
  });

  it("stores undirected edges in canonical order", () => {
    expect(canonical("channel:b", "channel:a")).toEqual(["channel:a", "channel:b"]);
    expect(edgeId("SIMILAR", ...canonical("channel:z", "channel:a"))).toBe("SIMILAR|channel:a|channel:z");
  });

  it("parses node ids", () => {
    expect(parseNodeId("channel:UCabc")).toEqual({ type: "CHANNEL", ref: "UCabc" });
    expect(parseNodeId("subniche:ai-ml")).toEqual({ type: "SUBNICHE", ref: "ai-ml" });
    expect(parseNodeId("bogus")).toBeNull();
    expect(parseNodeId("planet:x")).toBeNull();
  });
});
