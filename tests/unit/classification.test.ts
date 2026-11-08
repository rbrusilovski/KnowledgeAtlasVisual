import { describe, expect, it } from "vitest";
import { keywordScores, combine, selectLabels, rescaleCosine, WEIGHTS, TOPIC_CATEGORY_MAP, type SubnicheProfile } from "@/server/services/classification";

const subs: SubnicheProfile[] = [
  { id: "bake", slug: "baking", name: "Baking", description: "", parentSlug: "food", keywords: ["baking", "sourdough", "bread", "pastry", "laminated dough"] },
  { id: "k8s", slug: "devops-cloud", name: "DevOps", description: "", parentSlug: "technology", keywords: ["kubernetes", "docker", "terraform", "container"] },
  { id: "run", slug: "running", name: "Running", description: "", parentSlug: "health-fitness", keywords: ["running", "marathon", "pace"] },
];

describe("classification scoring", () => {
  it("weights sum to 1 with the spec ratios", () => {
    expect(WEIGHTS.embedding + WEIGHTS.keyword + WEIGHTS.topic).toBeCloseTo(1);
    expect(combine({ embedding: 1, keyword: 0, topic: 0 })).toBeCloseTo(0.55);
    expect(combine({ embedding: 0, keyword: 1, topic: 1 })).toBeCloseTo(0.45);
  });

  it("BM25-ish keyword score favours the matching subniche and lists matches", () => {
    const s = keywordScores("Sourdough breads and laminated dough. Weekly baking with pastry.", subs);
    expect(s.get("bake")!.score).toBeGreaterThan(s.get("k8s")!.score);
    expect(s.get("bake")!.matched).toEqual(expect.arrayContaining(["sourdough", "bread", "laminated dough"]));
    expect(s.get("run")!.score).toBe(0);
    for (const v of s.values()) expect(v.score).toBeLessThan(1);
  });

  it("rescales MiniLM cosines into 0..1", () => {
    expect(rescaleCosine(0.05)).toBe(0);
    expect(rescaleCosine(0.9)).toBe(1);
    expect(rescaleCosine(0.36)).toBeCloseTo(0.5, 1);
  });

  it("selects ≤ 3 labels, always keeps the best and flags low confidence", () => {
    const picks = selectLabels(
      [
        { id: "a", confidence: 0.6 },
        { id: "b", confidence: 0.5 },
        { id: "c", confidence: 0.45 },
        { id: "d", confidence: 0.44 },
        { id: "e", confidence: 0.1 },
      ],
      0.35,
    );
    expect(picks.map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(picks.every((p) => !p.lowConfidence)).toBe(true);
    const low = selectLabels([{ id: "x", confidence: 0.2 }, { id: "y", confidence: 0.19 }], 0.35);
    expect(low).toEqual([{ id: "x", confidence: 0.2, lowConfidence: true }]);
  });

  it("maps Wikipedia topic categories to niches", () => {
    expect(TOPIC_CATEGORY_MAP.get("https://en.wikipedia.org/wiki/Food")).toEqual(["food"]);
  });
});
