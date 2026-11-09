/**
 * pnpm taxonomy <command> — dynamic taxonomy over ALREADY-COLLECTED data. Never calls YouTube.
 *
 *   status                      counts (videos embedded/classified, niches by origin, recent runs)
 *   reconcile                   embed videos/channels missing vectors + extract missing topics (derived data)
 *   shadow [--json]             plan a taxonomy over the corpus and print it; writes only an audit row
 *   apply [--rebuild]           generate DYNAMIC niches + video evidence, project channels, rebuild graph nodes
 *   classify                    incremental: classify unlabelled videos, grow new categories from the pool
 *   reclassify --channels UC…,UC…  drop those channels' automatic video labels, prune empty generated categories,
 *                               then classify them again (already-collected data only)
 *   cleanup                     DRY RUN of demo-taxonomy retirement (exact rows, references, plan hash)
 *   cleanup --yes <hash>        execute exactly that reviewed plan (destructive; needs owner approval)
 */
import "dotenv/config";

const { db } = await import("@/server/db");
const { redis } = await import("@/server/redis");
const { closeQueues } = await import("@/server/jobs");
const { embedEntities } = await import("@/server/services/embeddings");
const { extractTopics } = await import("@/server/services/topics");
const { buildDirty } = await import("@/server/services/graph");
const tax = await import("@/server/services/taxonomy");

const [cmd = "status", ...rest] = process.argv.slice(2);
const flag = (f: string) => rest.includes(f);
const print = (x: unknown) => console.log(JSON.stringify(x, null, 2));

async function drainGraph(ids: string[]) {
  if (!ids.length) return;
  const s = await buildDirty([...new Set(ids)]);
  console.log(`graph: ${ids.length} dirty → nodes changed ${s?.nodesChanged ?? 0}, removed ${s?.nodesRemoved ?? 0}, edges changed ${s?.edgesChanged ?? 0}, removed ${s?.edgesRemoved ?? 0}`);
}

try {
  if (cmd === "status") print(await tax.taxonomyStatus());
  else if (cmd === "reconcile") {
    const vids = await db.$queryRaw<{ id: string }[]>`SELECT id FROM "Video" WHERE embedding IS NULL AND "isAvailable" ORDER BY id`;
    let done = 0;
    for (let i = 0; i < vids.length; i += 100) {
      const ids = vids.slice(i, i + 100).map((v) => v.id);
      done += (await embedEntities("video", ids, { followUps: false })).embedded;
      process.stdout.write(`\rvideos embedded ${done}/${vids.length}`);
    }
    console.log();
    const noTopics = await db.video.findMany({ where: { topicsAt: null, isAvailable: true }, select: { id: true } });
    for (let i = 0; i < noTopics.length; i += 200) {
      await extractTopics(noTopics.slice(i, i + 200).map((v) => v.id));
      process.stdout.write(`\rtopics ${Math.min(i + 200, noTopics.length)}/${noTopics.length}`);
    }
    console.log();
    const chans = await db.$queryRaw<{ id: string }[]>`SELECT id FROM "Channel" WHERE embedding IS NULL`;
    const ce = await embedEntities("channel", chans.map((c) => c.id), { followUps: false });
    console.log(`channels embedded ${ce.embedded}/${chans.length}`);
    print(await tax.taxonomyStatus());
  } else if (cmd === "shadow") {
    const r = await tax.bootstrapTaxonomy({ shadow: true });
    if (flag("--json") || !("plan" in r) || !r.plan) print(r);
    else {
      console.log(`run ${r.runId} · corpus ${JSON.stringify(r.plan.corpus)} · quality ${JSON.stringify(r.plan.quality)}\n`);
      for (const n of r.plan.niches) {
        console.log(`■ ${n.name}  [${n.slug}]  ${n.videos} videos · ${Object.entries(n.channels).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}`);
        for (const s of n.subniches) console.log(`   └ ${s.name}  (${s.videos}, cohesion ${s.cohesion})  kw: ${s.keywords.slice(0, 5).join(", ")}\n       e.g. ${s.samples.join(" | ")}`);
      }
    }
  } else if (cmd === "apply") {
    const r = await tax.bootstrapTaxonomy({ shadow: false, rebuild: flag("--rebuild") });
    if ("dirty" in r && r.dirty) {
      console.log(`run ${r.runId}: created ${r.created} categories, removed ${r.removed?.length ?? 0}`);
      await drainGraph(r.dirty);
    } else print(r);
    print(await tax.taxonomyStatus());
  } else if (cmd === "classify") {
    const ids = await tax.unclassifiedVideoIds();
    const r = await tax.classifyVideos(ids);
    print(r);
    // classifyVideos marks the graph dirty through the queue; build those nodes now for CLI use.
    const { buildFromDirtySet } = await import("@/server/services/graph");
    for (let i = 0; i < 5 && (await buildFromDirtySet()); i++);
  } else if (cmd === "reclassify") {
    const i = rest.indexOf("--channels");
    const yts = (i >= 0 ? rest[i + 1] ?? "" : "").split(",").filter(Boolean);
    if (!yts.length) throw new Error("reclassify requires --channels UC…,UC…");
    const ids = (await db.video.findMany({ where: { channel: { youtubeId: { in: yts } } }, select: { id: true } })).map((v) => v.id);
    const reset = await tax.resetVideoLabels(ids);
    console.log(`reset ${reset.labelsRemoved} labels on ${ids.length} videos; pruned ${reset.pruned.join(", ") || "nothing"}`);
    print(await tax.classifyVideos(ids));
    const chans = (await db.channel.findMany({ where: { youtubeId: { in: yts } }, select: { id: true } })).map((c) => c.id);
    const proj = await tax.projectChannels(chans);
    await tax.recomputeTaxonomyCounts();
    const { buildFromDirtySet } = await import("@/server/services/graph");
    await drainGraph([...proj.dirty, ...reset.pruned]);
    for (let k = 0; k < 5 && (await buildFromDirtySet()); k++);
  } else if (cmd === "cleanup") {
    const yes = rest.indexOf("--yes");
    if (yes < 0) {
      const p = await tax.planSeedCleanup();
      print(p);
      console.log(p.ready ? `\nDRY RUN. Nothing was changed. To execute exactly this plan (back up first: pg_dump):\n  pnpm taxonomy cleanup --yes ${p.hash}` : `\nDRY RUN — blocked: ${p.blockers.join("; ")}`);
    } else {
      const hash = rest[yes + 1];
      if (!hash) throw new Error("cleanup --yes requires the plan hash printed by the dry run");
      const r = await tax.executeSeedCleanup(hash);
      console.log(`deleted ${r.deleted} demo taxonomy rows`);
      await drainGraph(r.nodeIds);
      const { recomputeTaxonomyCounts } = tax;
      await recomputeTaxonomyCounts();
      print(await tax.taxonomyStatus());
    }
  } else {
    console.error(`unknown command ${cmd}`);
    process.exitCode = 2;
  }
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await closeQueues();
  await redis.quit();
  await db.$disconnect();
  process.exit(process.exitCode ?? 0);
}
