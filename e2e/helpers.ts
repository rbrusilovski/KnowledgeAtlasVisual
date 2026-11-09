import { expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

export const fixtureIndex = JSON.parse(readFileSync("fixtures/youtube/index.json", "utf8")) as { channels: { id: string; handle: string; title: string; subniche: string }[] };
/** The e2e server ingests the first 14 fixture channels; the rest are discoverable. */
export const INGESTED = fixtureIndex.channels.slice(0, 14);
export const NOT_INGESTED = fixtureIndex.channels.slice(14);

let n = 0;
export async function signUp(page: Page) {
  const email = `e2e-${Date.now()}-${n++}@atlas.test`;
  const base = new URL(page.context().pages()[0]?.url() || "http://localhost:3100").origin;
  const origin = base.startsWith("http") && !base.includes("about:") ? base : "http://localhost:3100";
  const res = await page.request.post("/api/auth/sign-up/email", { data: { email, password: "e2e-password-123", name: "E2E" }, headers: { origin } });
  expect(res.ok()).toBeTruthy();
  return email;
}

type AtlasWindow = { __atlas?: { atlas: { viewportPos(id: string): { x: number; y: number } | null; isLayoutRunning(): boolean; sigma: unknown }; graph: { order: number; hasNode(id: string): boolean; nodes(): string[]; getNodeAttributes(id: string): { x: number; y: number; pinned?: boolean } } } };

export async function openAtlas(page: Page, query = "") {
  await page.goto(`/atlas${query}`);
  await page.waitForFunction(() => {
    const a = (window as unknown as AtlasWindow).__atlas;
    return Boolean(a?.atlas.sigma) && (a?.graph.order ?? 0) > 10;
  }, undefined, { timeout: 60_000 });
}

/** Wait for the initial ForceAtlas2 run to start (if it's going to) and then finish, so positions are stable. */
export async function waitForLayoutIdle(page: Page) {
  await page.waitForFunction(() => (window as unknown as AtlasWindow).__atlas!.atlas.isLayoutRunning(), undefined, { timeout: 5_000 }).catch(() => undefined);
  await page.waitForFunction(() => !(window as unknown as AtlasWindow).__atlas!.atlas.isLayoutRunning(), undefined, { timeout: 30_000 });
  await page.waitForTimeout(400);
}

export async function graphOrder(page: Page) {
  return page.evaluate(() => (window as unknown as AtlasWindow).__atlas!.graph.order);
}

/** Absolute page coordinates of a node on the canvas. */
export async function nodePoint(page: Page, nodeId: string) {
  const p = await page.evaluate((id) => (window as unknown as AtlasWindow).__atlas!.atlas.viewportPos(id), nodeId);
  const box = await page.getByTestId("atlas-canvas").boundingBox();
  if (!p || !box) throw new Error(`node ${nodeId} not on canvas`);
  return { x: box.x + p.x, y: box.y + p.y };
}

export async function nodeAttrs(page: Page, nodeId: string) {
  return page.evaluate((id) => (window as unknown as AtlasWindow).__atlas!.graph.getNodeAttributes(id), nodeId);
}

export async function hasNode(page: Page, nodeId: string) {
  return page.evaluate((id) => (window as unknown as AtlasWindow).__atlas!.graph.hasNode(id), nodeId);
}

/** Zoom the camera onto a node so dense layouts can't put a neighbour or label under the cursor. */
export async function zoomToNode(page: Page, nodeId: string) {
  type Cam = { isAnimating(): boolean; getState(): { x: number; y: number; ratio: number } };
  type W = { __atlas: { atlas: { flyTo(id: string, r: number): boolean; sigma: { getCamera(): Cam } } } };
  await page.evaluate((id) => (window as unknown as W).__atlas.atlas.flyTo(id, 0.08), nodeId);
  // Wait for the camera animation to finish and the view to settle (slow first renders on cold CI runners).
  await page.waitForFunction(() => !(window as unknown as W).__atlas.atlas.sigma.getCamera().isAnimating(), undefined, { timeout: 15_000 });
  await page.waitForTimeout(300);
}
