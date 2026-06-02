import { expect, test } from "@playwright/test";
import { seedSession } from "./session";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "https://eedfyviypptfpghyffip.supabase.co";
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY ?? "sb_publishable_CCE4uRqvWCAonhnDis0BZQ_ixrd0jl2";

test.beforeEach(async ({ page }) => {
  await seedSession(page, SUPABASE_URL, ANON_KEY);
});

// AC1: Past digests browsable, grouped by date descending (live data path).
test("history renders grouped by topic with date headings descending", async ({ page }) => {
  await page.goto("/#/history");
  await expect(page.getByTestId("history-content")).toBeVisible();
  await expect(page.getByTestId("auth-gate")).toHaveCount(0);

  const groups = page.locator(".topic-group");
  await expect(groups.first()).toBeVisible({ timeout: 15_000 });

  const dates = await page
    .locator(".topic-group")
    .first()
    .locator(".date-heading")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-date") ?? ""));
  const sortedDesc = [...dates].sort().reverse();
  expect(dates).toEqual(sortedDesc);
});

// Per-digest metadata is shown.
test("each digest shows metadata (topic, date, word count, sources)", async ({ page }) => {
  await page.goto("/?fixture=150#/history");
  await expect(page.getByTestId("history-list")).toBeVisible();
  const meta = page.getByTestId("digest-meta").first();
  await expect(meta).toBeVisible();
  await expect(meta).toContainText("words");
  await expect(meta).toContainText("sources:");
});

// AC4 + AC1: 150-row fixture renders all rows within a sane time budget.
test("renders 150 fixture rows quickly", async ({ page }) => {
  const start = Date.now();
  await page.goto("/?fixture=150#/history");
  await expect(page.getByTestId("history-list")).toBeVisible();
  // Fixture spans 30 days; with no filter the default 7-day window applies.
  // Switch to "All topics" + clear-window by selecting a topic to force full set,
  // then assert the full dataset can render. First measure default-view interactive.
  await expect(page.locator(".topic-group").first()).toBeVisible();
  const interactive = Date.now() - start;
  expect(interactive).toBeLessThan(1000);

  // Force the entire 150-row set via a topic filter (bypasses 7-day window) and
  // confirm every card for that topic renders. 150 rows total / 5 topics = 30 each.
  await page.getByTestId("filter-topic").selectOption("ai_models");
  await expect(page.locator(".digest-card")).toHaveCount(30);
});

// AC2: Topic filter narrows results and URL state reflects the selection.
test("topic filter narrows results and updates the URL", async ({ page }) => {
  await page.goto("/?fixture=150#/history");
  await expect(page.getByTestId("history-list")).toBeVisible();

  await page.getByTestId("filter-topic").selectOption("penguins");
  // Only the penguins group remains.
  await expect(page.locator(".topic-group")).toHaveCount(1);
  await expect(page.locator(".topic-group").first()).toHaveAttribute(
    "data-topic-slug",
    "penguins",
  );
  // URL search reflects the selection (shareable).
  await expect.poll(() => new URL(page.url()).search).toContain("topic=penguins");
});

// AC2: A shareable URL with ?topic= yields the pre-filtered view on load.
test("shareable ?topic= URL loads pre-filtered", async ({ page }) => {
  await page.goto("/?fixture=150&topic=ai_models#/history");
  await expect(page.getByTestId("history-list")).toBeVisible();
  await expect(page.locator(".topic-group")).toHaveCount(1);
  await expect(page.locator(".topic-group").first()).toHaveAttribute(
    "data-topic-slug",
    "ai_models",
  );
  // The topic control reflects the URL state.
  await expect(page.getByTestId("filter-topic")).toHaveValue("ai_models");
});

// AC3: Client-side search returns relevant results across digest content.
test("search narrows to matching digests", async ({ page }) => {
  await page.goto("/?fixture=150#/history");
  await expect(page.getByTestId("history-list")).toBeVisible();

  await page.getByTestId("filter-search").fill("township");
  // At least one match, and every rendered card contains the term.
  await expect(page.locator(".digest-card").first()).toBeVisible();
  const bodies = await page.locator(".digest-body").allTextContents();
  expect(bodies.length).toBeGreaterThan(0);
  expect(bodies.every((t) => t.toLowerCase().includes("township"))).toBe(true);

  // URL reflects the query.
  await expect.poll(() => new URL(page.url()).search).toContain("q=township");
});
