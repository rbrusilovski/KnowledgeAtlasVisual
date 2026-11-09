/**
 * pnpm graph:evaluate — precision / recall / calibration / evidence / stability of channel↔channel relationships and
 * top-1 accuracy of niche classification against gold labels (fixture subniches, or manual labels in live mode).
 * Run it before changing SIMILAR / CO_TOPIC thresholds. The report is also kept in Redis for /admin.
 */
import "dotenv/config";

const { db } = await import("@/server/db");
const { redis } = await import("@/server/redis");
const { closeQueues } = await import("@/server/jobs");
const { evaluateQuality } = await import("@/server/services/graph");

try {
  const r = await evaluateQuality();
  const pct = (x: number | null) => (x === null ? "  –  " : `${(x * 100).toFixed(1).padStart(5)}%`);
  console.log(`gold: ${r.goldSource} · ${r.labelledChannels} labelled channels · ${r.sameSubnichePairs} same-subniche pairs\n`);
  console.log("kind           label     edges  precision  parent  recall  strong/weak   evidence  stability");
  for (const k of r.kinds) {
    console.log(`${k.kind.padEnd(14)} ${k.label.padEnd(8)} ${String(k.edges).padStart(6)}  ${pct(k.precision)}    ${pct(k.precisionParent)} ${pct(k.recall)}  ${pct(k.calibration.strongHalf)}/${pct(k.calibration.weakHalf)}  ${pct(k.evidenceRate)}   ${pct(k.stability)}`);
  }
  if (r.similarSweep) {
    console.log("\nSIMILAR threshold sweep (cosine ≥ t over all labelled pairs):");
    for (const s of r.similarSweep) console.log(`  t=${s.threshold.toFixed(2)}  pairs ${String(s.pairs).padStart(6)}  precision ${pct(s.precision)}  recall ${pct(s.recall)}`);
  }
  const c = r.classification;
  console.log(`\nclassification: ${c.evaluated} channels · top-1 ${pct(c.top1)} · gold in labels ${pct(c.anyLabel)} · parent niche ${pct(c.parentTop1)}`);
} finally {
  await closeQueues();
  await redis.quit();
  await db.$disconnect();
}
process.exit(0);
