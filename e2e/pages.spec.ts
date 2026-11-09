import { test, expect } from "@playwright/test";
import { signUp, INGESTED, NOT_INGESTED, E2E_ORIGIN } from "./helpers";

test.describe("pages", () => {
  test("discover search → add channel → shows as in atlas (live)", async ({ page }) => {
    await signUp(page);
    await page.goto("/discover");
    const target = NOT_INGESTED.find((c) => c.subniche === "baking") ?? NOT_INGESTED[8]!;
    await page.getByTestId("discover-input").fill(target.title);
    await expect(page.getByTestId("discover-cost")).toContainText("Uses 1 of");
    await page.getByTestId("discover-submit").click();
    const card = page.getByTestId("discover-results").getByRole("listitem").filter({ hasText: target.title }).first();
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.getByTestId("add-to-atlas").click();
    await page.getByTestId("proposal-approve").click();
    await expect(card.getByText(/Requested|In atlas/)).toBeVisible();
    await expect(card.getByText("In atlas")).toBeVisible({ timeout: 120_000 });
  });

  test("channel page: search within channel", async ({ page }) => {
    const ch = INGESTED[4]!;
    const videos = await (await page.request.get(`/api/channels/${ch.id}/videos?limit=50`)).json();
    const title: string = videos.data[0].title;
    const word = title.split(/\s+/).filter((w: string) => w.length > 5 && /^[a-z]+$/i.test(w))[0] ?? title.split(" ")[0]!;
    await page.goto(`/channels/${ch.id}`);
    await expect(page.getByRole("heading", { name: ch.title })).toBeVisible();
    await page.getByTestId("channel-search").fill(word);
    const list = page.getByTestId("channel-videos");
    await expect(list.getByRole("link").first()).toBeVisible();
    await expect(list).toContainText(new RegExp(word, "i"), { timeout: 15_000 });
  });

  test("video page: transcript search jumps to timestamp", async ({ page }) => {
    // Signed out: transcript text is neither searchable nor readable.
    const anon = await (await page.request.get("/api/search?q=fundamentals&types=transcript&mode=keyword&limit=1")).json();
    expect(anon.data).toEqual([]);
    await signUp(page);
    const r = await (await page.request.get("/api/search?q=fundamentals&types=transcript&mode=keyword&limit=1")).json();
    expect(r.data.length).toBeGreaterThan(0);
    const id: string = r.data[0].nodeId.slice(6);
    await page.goto(`/videos/${id}`);
    await page.getByTestId("transcript-search").fill("fundamentals");
    const hit = page.getByTestId("transcript-hits").getByRole("button").first();
    await expect(hit).toBeVisible({ timeout: 15_000 });
    await hit.click();
    await expect(page).toHaveURL(/[?&]t=\d+/);
    await expect(page.locator("[data-testid=transcript-chunks] [data-active]")).toBeVisible();
  });

  test("search page: hybrid results with type tabs", async ({ page }) => {
    await page.goto("/search?q=neural%20network");
    await expect(page.getByTestId("search-results").getByRole("listitem").first()).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: /^Videos/ }).click();
    await expect(page).toHaveURL(/type=video/);
    await expect(page.getByTestId("search-results")).toContainText("video");
  });

  test("data page: a pending proposal is reviewed and rejected; nothing is collected", async ({ page }) => {
    await signUp(page);
    const target = NOT_INGESTED.find((c) => c.subniche === "devops-cloud") ?? NOT_INGESTED[12]!;
    const created = await page.request.post("/api/channels", { data: { input: target.id }, headers: { origin: E2E_ORIGIN } });
    expect(created.status()).toBe(201);
    await page.goto("/data");
    const row = page.getByTestId("proposal-row").filter({ hasText: target.id }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.getByTestId("proposal-review-open").click();
    await expect(page.getByTestId("proposal-review")).toContainText("Your request");
    await page.getByTestId("proposal-reject").click();
    await expect(page.getByTestId("proposal-review")).toBeHidden();
    const ch = await page.request.get(`/api/channels/${target.id}`);
    expect(ch.status()).toBe(404);
    await expect(page.getByText("Nothing waiting for approval")).toBeVisible({ timeout: 10_000 });
  });

  test("video page: shows collected-data coverage; uploaded transcripts are private", async ({ page }) => {
    await signUp(page);
    const ch = INGESTED[3]!;
    const videos = await (await page.request.get(`/api/channels/${ch.id}/videos?limit=50`)).json();
    const v = (videos.data as { nodeId: string; meta: { hasTranscript: boolean } }[]).find((x) => !x.meta.hasTranscript)!;
    const yt = v.nodeId.slice(6);
    await page.goto(`/videos/${yt}`);
    await expect(page.getByTestId("video-coverage")).toContainText("complete");
    const up = await page.request.post(`/api/videos/${yt}/transcript`, { data: { text: "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nmy private notes", filename: "n.vtt" }, headers: { origin: E2E_ORIGIN } });
    expect(up.status()).toBe(201);
    await page.reload();
    await expect(page.getByTestId("transcript-private")).toBeVisible();
    // Anonymous visitors can't read transcripts at all (sign-in required).
    const anon = await page.context().browser()!.newContext();
    expect((await anon.request.get(`${E2E_ORIGIN}/api/videos/${yt}/transcript`)).status()).toBe(401);
    const anonPage = await anon.newPage();
    await anonPage.goto(`${E2E_ORIGIN}/videos/${yt}`);
    await expect(anonPage.getByTestId("transcript-signin")).toBeVisible();
    await expect(anonPage.getByText("my private notes")).toHaveCount(0);
    await anon.close();
  });
});
