import { test, expect, request as pwRequest, type APIRequestContext } from "@playwright/test";
import { signUp, NOT_INGESTED } from "./helpers";

/**
 * Prompt §16.3 / deferred D13: the Claude flow end to end, using the same HTTP tool API the MCP adapter calls.
 * User opens Atlas → creates an agent token → "Claude" inspects coverage, estimates and proposes → user reviews and
 * approves in Atlas → the job runs inside the approved scope → the data appears in search and graph with provenance.
 */
test("Claude inspects coverage, proposes a bounded expansion, the user approves, data appears with provenance", async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  await signUp(page);

  // 1. The user creates an agent token in Settings (shown once).
  await page.goto("/settings");
  await page.getByTestId("create-agent-token").click();
  const token = (await page.getByTestId("agent-token-value").textContent())!.trim();
  expect(token).toMatch(/^atl_/);

  // 2. "Claude" uses a separate client with no browser cookies — only the bearer token.
  const claude: APIRequestContext = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { authorization: `Bearer ${token}` } });
  const tool = async <T>(name: string, input: unknown = {}) => {
    const r = await claude.post(`/api/agent/tools/${name}`, { data: input });
    expect(r.ok(), `${name}: ${r.status()} ${await r.text()}`).toBeTruthy();
    return ((await r.json()) as { data: T }).data;
  };

  const tools = (await (await claude.get("/api/agent/tools")).json()) as { data: { tools: { name: string }[] } };
  expect(tools.data.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["atlas_inspect_coverage", "atlas_create_expansion_proposal"]));
  expect(tools.data.tools.some((t) => /approve/.test(t.name))).toBe(false);

  const coverage = await tool<{ channels: { total: number } }>("atlas_inspect_coverage", { scope: "atlas" });
  expect(coverage.channels.total).toBeGreaterThan(0);

  // 3. Gap: a gardening channel is not in Atlas yet. Estimate, then propose a bounded addition.
  const target = NOT_INGESTED.find((c) => c.subniche === "gardening") ?? NOT_INGESTED[5]!;
  const scope = { kind: "ADD_CHANNELS", channels: [{ youtubeId: target.id }], maxVideosPerChannel: 12, includeTranscripts: false };
  const est = await tool<{ estimate: { quotaUnits: number; isEstimate: boolean }; redundancy: { redundant: boolean } }>("atlas_estimate_expansion", { scope });
  expect(est.redundancy.redundant).toBe(false);
  expect(est.estimate.isEstimate).toBe(true);
  const created = await tool<{ proposal: { id: string; status: string; source: string }; reviewUrl: string }>("atlas_create_expansion_proposal", {
    scope,
    reason: `No ${target.subniche} channel has been collected yet`,
    coverageGap: `subniche ${target.subniche} has no channels`,
  });
  expect(created.proposal).toMatchObject({ status: "PENDING", source: "CLAUDE" });

  // Claude cannot approve with its token — the approval route only accepts the signed-in user's session.
  const sneaky = await claude.post(`/api/expansions/${created.proposal.id}/approve`, { data: { scopeHash: "0".repeat(64) } });
  expect(sneaky.status()).toBe(401);

  // 4–6. The user opens the review link, sees it is Claude's proposal, and approves this exact scope.
  await page.goto(created.reviewUrl);
  const review = page.getByTestId("proposal-review");
  await expect(review).toContainText("Proposed by Claude", { timeout: 20_000 });
  await expect(review).toContainText(target.id);
  await page.getByTestId("proposal-approve").click();
  await expect(review).toBeHidden();

  // 7. The job executes within the approved scope.
  await expect
    .poll(async () => (await tool<{ status: string }>("atlas_get_proposal_status", { id: created.proposal.id })).status, { timeout: 150_000, intervals: [1_000, 2_000, 3_000] })
    .toBe("COMPLETED");
  const status = await tool<{ actual: { results: Record<string, unknown> } }>("atlas_get_proposal_status", { id: created.proposal.id });
  expect(status.actual).toBeTruthy();
  const channel = await tool<{ youtubeId: string; latestVideos: { youtubeId: string }[]; videoCount: number | null }>("atlas_get_channel", { id: target.id });
  expect(channel.latestVideos.length).toBeGreaterThan(0);
  const stored = await page.request.get(`/api/channels/${target.id}/videos?limit=50`);
  expect(((await stored.json()) as { data: unknown[] }).data.length).toBeLessThanOrEqual(12);

  // 9. New data appears in search and graph; 10. provenance tells fact from inference.
  await expect
    .poll(async () => (await tool<{ items: { nodeId: string }[] }>("atlas_search_existing", { q: target.title, mode: "keyword", types: ["channel"] })).items.map((i) => i.nodeId), { timeout: 30_000 })
    .toContain(`channel:${target.id}`);
  await expect
    .poll(async () => {
      const r = await tool<{ connected: boolean; edges: { provenance: { label: string } }[] }>("atlas_explain_relationship", { from: `channel:${target.id}`, to: `video:${channel.latestVideos[0]!.youtubeId}` });
      return r.connected ? r.edges[0]?.provenance.label : null;
    }, { timeout: 60_000 })
    .toBe("FACT");
  await claude.dispose();
});
