import { describe, expect, it } from "vitest";
import { singularize, normalizePhrase, ngrams, candidateFrequencies, topPhrases, trigramSimilarity, slugify } from "@/server/services/topics";

describe("topic normalization", () => {
  it.each([
    ["recipes", "recipe"],
    ["strategies", "strategy"],
    ["classes", "class"],
    ["boxes", "box"],
    ["physics", "physics"],
    ["kubernetes", "kubernetes"],
    ["analysis", "analysis"],
    ["glass", "glass"],
    ["bus", "bus"],
  ])("singularize %s → %s", (a, b) => expect(singularize(a)).toBe(b));

  it("normalizes case, punctuation and plurals", () => {
    expect(normalizePhrase("Sourdough Breads!")).toBe("sourdough bread");
    expect(normalizePhrase("Neural-Networks")).toBe("neural-network");
    expect(normalizePhrase("C++ Templates")).toBe("c++ template");
  });

  it("builds 1–3-grams without stopword edges or crossing punctuation", () => {
    const g = ngrams("The history of sourdough bread, explained");
    expect(g).toContain("sourdough bread");
    expect(g).toContain("sourdough");
    expect(g).not.toContain("of sourdough");
    expect(g).not.toContain("bread explained");
    expect(g.some((x) => x.includes("history"))).toBe(false);
  });

  it("slugifies safely", () => {
    expect(slugify("c++ template")).toBe("cplusplus-template");
    expect(slugify("c# basics")).toBe("csharp-basics");
  });
});

describe("TF-IDF keyphrase ranking", () => {
  const tf = candidateFrequencies({
    title: "Sourdough bread starter guide",
    tags: ["sourdough bread", "baking", "yeast"],
    description: "We feed the sourdough starter and bake bread. Subscribe for more! 00:00 Intro",
  });
  it("weights titles and tags above description", () => {
    expect(tf.get("sourdough bread")!).toBeGreaterThan(tf.get("yeast")!);
    expect(tf.has("subscribe")).toBe(false);
    expect(tf.has("intro")).toBe(false);
  });
  it("prefers rare phrases and prunes subsumed unigrams", () => {
    const df = (p: string) => (p === "baking" ? 500 : p === "bread" ? 300 : 2);
    const top = topPhrases(tf, df, 1000, 5).map((s) => s.phrase);
    expect(top[0]).toBe("sourdough bread");
    expect(top).not.toContain("bread");
    expect(top.length).toBeLessThanOrEqual(5);
  });
});

describe("trigram similarity (pg_trgm semantics)", () => {
  it("is high for near-duplicates and low for unrelated", () => {
    expect(trigramSimilarity("neural network", "neural networks")).toBeGreaterThanOrEqual(0.8);
    expect(trigramSimilarity("sourdough", "kubernetes")).toBeLessThan(0.1);
    expect(trigramSimilarity("abc", "abc")).toBe(1);
  });
});
