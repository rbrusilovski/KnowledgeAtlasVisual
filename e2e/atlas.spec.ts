import { test, expect } from "@playwright/test";
import { signUp, openAtlas, waitForLayoutIdle, graphOrder, nodePoint, nodeAttrs, hasNode, zoomToNode, INGESTED, NOT_INGESTED } from "./helpers";

test.describe("atlas", () => {
  test("sign up → atlas renders nodes (list view + counts)", async ({ page }) => {
    await page.goto("/signin");
    await page.getByRole("button", { name: "Create an account" }).click();
    await page.getByLabel("Name").fill("Playwright");
    await page.getByLabel("Email").fill(`ui-${Date.now()}@atlas.test`);
    await page.getByLabel("Password").fill("e2e-password-123");
    await page.getByRole("button", { name: "Create account" }).click();
    await page.waitForURL("**/atlas");
    await openAtlas(page);
    await expect(page.getByTestId("graph-counts")).toContainText("nodes");
    await page.getByRole("button", { name: "List view" }).click();
    const count = Number(await page.getByTestId("list-count").innerText());
    expect(count).toBeGreaterThan(20);
    await expect(page.getByTestId("list-view").getByRole("row").filter({ hasText: INGESTED[0]!.title })).toHaveCount(1);
    // The workspace + Favorites collection were created at signup.
    await expect(page.getByText("Favorites")).toBeVisible();
  });

  test("⌘K search → focus node in the inspector", async ({ page }) => {
    await signUp(page);
    await openAtlas(page);
    const target = INGESTED[3]!;
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("palette-input").fill(target.title.slice(0, 8));
    await page.getByRole("option", { name: new RegExp(target.title) }).first().click();
    await expect(page.getByTestId("inspector")).toContainText(target.title, { timeout: 20_000 });
    expect(await hasNode(page, `channel:${target.id}`)).toBe(true);
  });

  test("double-click expands a node (node count increases)", async ({ page }) => {
    await signUp(page);
    await openAtlas(page);
    await waitForLayoutIdle(page);
    const id = `channel:${INGESTED[0]!.id}`;
    const before = await graphOrder(page);
    await zoomToNode(page, id);
    const p = await nodePoint(page, id);
    await page.mouse.dblclick(p.x, p.y);
    await expect.poll(() => graphOrder(page), { timeout: 20_000 }).toBeGreaterThan(before);
  });

  test("drag a node → reload → position persisted", async ({ page }) => {
    await signUp(page);
    await openAtlas(page);
    await waitForLayoutIdle(page);
    const id = `channel:${INGESTED[1]!.id}`;
    await zoomToNode(page, id);
    const p = await nodePoint(page, id);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(p.x + 60, p.y + 40, { steps: 8 });
    await page.mouse.move(p.x + 120, p.y + 80, { steps: 8 });
    await page.mouse.up();
    const dragged = await nodeAttrs(page, id);
    expect(dragged.pinned).toBe(true);
    await page.waitForResponse((r) => r.url().includes("/layout") && r.request().method() === "PUT", { timeout: 10_000 });
    await openAtlas(page);
    const after = await nodeAttrs(page, id);
    expect(after.x).toBeCloseTo(dragged.x, 3);
    expect(after.y).toBeCloseTo(dragged.y, 3);
    expect(after.pinned).toBe(true);
  });

  test("add to collection → reload → persisted", async ({ page }) => {
    await signUp(page);
    const target = INGESTED[2]!;
    await openAtlas(page, `?focus=${encodeURIComponent(`channel:${target.id}`)}&mode=local&depth=1`);
    await page.evaluate((id) => window.dispatchEvent(new CustomEvent("atlas:focus", { detail: id })), `channel:${target.id}`);
    const inspector = page.getByTestId("inspector");
    await expect(inspector).toContainText(target.title, { timeout: 20_000 });
    await inspector.getByRole("button", { name: "Save" }).click();
    await page.getByRole("menuitem", { name: "Favorites" }).click();
    await expect(page.getByText("Saved to Favorites")).toBeVisible();
    await page.goto("/collections");
    await expect(page.getByRole("link", { name: /Favorites\s+1 items/ })).toBeVisible();
    await page.getByRole("link", { name: /Favorites/ }).click();
    await page.waitForURL(/\/collections\/[\w-]+$/);
    await page.reload();
    await expect(page.getByTestId("collection-items")).toContainText(target.title);
  });

  test("add a channel → node appears in the open atlas without reload (SSE)", async ({ page }) => {
    await signUp(page);
    await openAtlas(page);
    const target = NOT_INGESTED.find((c) => c.subniche === "recipes") ?? NOT_INGESTED[5]!;
    expect(await hasNode(page, `channel:${target.id}`)).toBe(false);
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("palette-input").fill("add");
    await page.getByRole("option", { name: "Add channel by URL" }).click();
    await page.getByTestId("add-channel-input").fill(`https://www.youtube.com/@${target.handle}`);
    await page.getByRole("button", { name: "Add to atlas" }).click();
    await expect.poll(() => hasNode(page, `channel:${target.id}`), { timeout: 120_000, intervals: [1000] }).toBe(true);
  });
});
