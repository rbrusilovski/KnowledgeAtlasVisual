import { describe, expect, it } from "vitest";
import { centerVec, kmeans, enforceSupport, agglomerate, leaderClusters, clusterTerms, nameFromTerms, meanNormalized, dot, docTerms, confidenceFromCos, TAXONOMY_CONFIG } from "@/server/services/taxonomy";

/** Three well-separated "topics" in 8d plus small deterministic noise. */
function blob(axis: number, n: number, jitter = 0.08): number[][] {
  return Array.from({ length: n }, (_, i) => {
    const v = Array.from({ length: 8 }, (_, d) => (d === axis ? 1 : Math.sin(i * 7.3 + d * 1.9) * jitter));
    return meanNormalized([v]);
  });
}

describe("taxonomy clustering", () => {
  const pts = [...blob(0, 20), ...blob(3, 20), ...blob(6, 20)];

  it("k-means is deterministic and separates distinct groups", () => {
    const a = kmeans(pts, 3, { seed: 7 });
    const b = kmeans(pts, 3, { seed: 7 });
    expect(a.assign).toEqual(b.assign);
    const groups = [0, 20, 40].map((s) => new Set(a.assign.slice(s, s + 20)));
    groups.forEach((g) => expect(g.size).toBe(1));
    expect(new Set(groups.map((g) => [...g][0])).size).toBe(3);
  });

  it("enforceSupport dissolves tiny clusters and merges near-duplicates", () => {
    // over-cluster: 6 clusters for 3 real groups
    const km = kmeans(pts, 6, { seed: 1 });
    const r = enforceSupport(pts, km.assign, 10, 0.9);
    expect(new Set(r.assign).size).toBe(3);
    for (let c = 0; c < 3; c++) expect(r.assign.filter((x) => x === c).length).toBeGreaterThanOrEqual(10);
    // a lone outlier never keeps its own category
    const withOutlier = [...pts, meanNormalized([[0, 1, 0, 0, 0, 0, 0, 0]])];
    const r2 = enforceSupport(withOutlier, [...kmeans(pts, 3, { seed: 7 }).assign, 3], 5, 0.95);
    expect(new Set(r2.assign).size).toBe(3);
  });

  it("agglomerate groups similar centroids into parents", () => {
    const cents = [blob(0, 1)[0]!, meanNormalized([[1, 0.3, 0, 0, 0, 0, 0, 0]]), blob(6, 1)[0]!];
    const g = agglomerate(cents, [10, 10, 10], 2);
    expect(g[0]).toBe(g[1]);
    expect(g[2]).not.toBe(g[0]);
  });

  it("leader clustering forms pool groups by cosine", () => {
    const groups = leaderClusters([...blob(1, 5), ...blob(5, 3)], 0.8);
    expect(groups.map((g) => g.length)).toEqual([5, 3]);
  });

  it("meanNormalized returns unit vectors", () => {
    const m = meanNormalized(pts);
    expect(dot(m, m)).toBeCloseTo(1);
  });
});

describe("taxonomy naming", () => {
  const primes = Array.from({ length: 6 }, (_, i) => ({ title: `Prime numbers puzzle ${i}`, tags: ["prime numbers", "number theory"], topics: [] }));
  const quantum = Array.from({ length: 6 }, (_, i) => ({ title: `Quantum mechanics explained part ${i}`, tags: ["quantum mechanics", "physics"], topics: ["quantum entanglement"] }));

  it("c-TF-IDF picks distinctive terms per cluster and names them", () => {
    const [a, b] = clusterTerms([primes, quantum], new Set());
    expect(a!.map((t) => t.term)).toContain("prime number");
    expect(b![0]!.term).toMatch(/^quantum/);
    expect(nameFromTerms(a!, "x")).toMatch(/^(Prime Number|Number Theory)( & .+)?$/);
  });

  it("excludes channel names and generic words, and requires support", () => {
    const terms = [...docTerms({ title: "Numberphile video: official trailer", tags: ["numberphile"], topics: [] }, new Set(["numberphile"])).keys()];
    expect(terms).not.toContain("numberphile");
    expect(terms.some((t) => t.includes("trailer"))).toBe(false);
    const one = [{ title: "Zebra stripes", tags: [], topics: [] }, ...primes];
    const [t] = clusterTerms([one, quantum], new Set());
    expect(t!.map((x) => x.term)).not.toContain("zebra stripe");
  });

  it("falls back when no term has support", () => {
    expect(nameFromTerms([], "Cluster 3")).toBe("Cluster 3");
  });
});

describe("centering", () => {
  it("removes the shared component so unrelated vectors stop looking similar", () => {
    const common = meanNormalized([[1, 1, 1, 1, 0, 0, 0, 0]]);
    const a = meanNormalized([common.map((x, i) => x * 3 + (i === 4 ? 1 : 0))]);
    const b = meanNormalized([common.map((x, i) => x * 3 + (i === 5 ? 1 : 0))]);
    const mean = meanNormalized([a, b]);
    expect(dot(a, b)).toBeGreaterThan(0.8);
    expect(dot(centerVec(a, mean), centerVec(b, mean))).toBeLessThan(0);
    expect(centerVec(a, null)).toBe(a);
  });
});

describe("taxonomy config", () => {
  it("thresholds are ordered sensibly", () => {
    expect(TAXONOMY_CONFIG.dupCentered).toBeGreaterThan(TAXONOMY_CONFIG.poolCentered);
    expect(TAXONOMY_CONFIG.poolCentered).toBeGreaterThan(TAXONOMY_CONFIG.reuseCentered);
    expect(TAXONOMY_CONFIG.minNewTopSupport).toBeGreaterThan(TAXONOMY_CONFIG.minNewSubSupport);
    expect(confidenceFromCos(0.2)).toBe(0);
    expect(confidenceFromCos(0.9)).toBe(1);
  });
});
