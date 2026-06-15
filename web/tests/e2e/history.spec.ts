import { expect, test } from "@playwright/test";
import { LIVE_AUTH, LIVE_AUTH_SKIP, signInAal2 } from "./live-auth";
import { seedSession } from "./session";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "https://eedfyviypptfpghyffip.supabase.co";
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY ?? "sb_publishable_CCE4uRqvWCAonhnDis0BZQ_ixrd0jl2";

// AC1 (issue #101): Past digests browsable, grouped DATE-FIRST then by topic,
// dates descending, and TODAY is excluded (today lives on Home). Reads real
// digests from Supabase, so it needs a genuine authenticated (AAL2) session
// (RLS gates reads to the `authenticated` role).
test.describe("history (live authenticated reads)", () => {
  test.skip(!LIVE_AUTH, LIVE_AUTH_SKIP);

  test.beforeEach(async ({ page }) => {
    await signInAal2(page);
  });

  test("history renders date-first headings descending with today excluded", async ({ page }) => {
    await page.goto("/#/history");
    await expect(page.getByTestId("history-content")).toBeVisible();
    await expect(page.getByTestId("auth-gate")).toHaveCount(0);

    // Top-level groups are now DATES (issue #101 changed topic-first -> date-first).
    const dateGroups = page.locator("section.date-group");
    await expect(dateGroups.first()).toBeVisible({ timeout: 15_000 });

    // Each date section carries its calendar date on data-date; collect descending.
    const dates = await page
      .locator("section.date-group")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-date") ?? ""));
    const sortedDesc = [...dates].sort().reverse();
    expect(dates).toEqual(sortedDesc);

    // Today must NOT appear in History — it is shown on Home instead. The app's
    // canonical "today" is America/New_York (see src/lib/dates.ts).
    const todayET = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
    }).format(new Date());
    expect(dates).not.toContain(todayET);

    // Topics are nested beneath each date as h3 headings.
    const topicHeadings = page.locator("section.date-group h3.topic-heading");
    if ((await dateGroups.count()) > 0) {
      await expect(topicHeadings.first()).toBeVisible();
    }
  });
});

// The remaining specs exercise filtering/search/grouping/perf over the deterministic
// in-app fixture (`?fixture=150`), which generates rows client-side and does NOT read
// Supabase. They only need the auth gate to pass, so a seeded (gate-only) session is
// sufficient and they run without live credentials.
test.describe("history (fixture data)", () => {
  test.beforeEach(async ({ page }) => {
    await seedSession(page, SUPABASE_URL, ANON_KEY);
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
  // The fixture spans 2026-06-01 back ~30 days, none of which is the wall-clock
  // "today", so excludeToday() drops nothing here and all 30 rows for a topic show.
  test("renders 150 fixture rows quickly", async ({ page }) => {
    const start = Date.now();
    await page.goto("/?fixture=150#/history");
    await expect(page.getByTestId("history-list")).toBeVisible();
    // Top-level grouping is date-first (issue #101): assert a date section renders.
    await expect(page.locator("section.date-group").first()).toBeVisible();
    const interactive = Date.now() - start;
    expect(interactive).toBeLessThan(1000);

    // Filter to a single topic and confirm every card for that topic renders.
    // 150 rows total / 5 topics = 30 each (across 30 distinct dates).
    await page.getByTestId("filter-topic").selectOption("ai_models");
    await expect(page.locator(".digest-card")).toHaveCount(30);
  });

  // AC2: Topic filter narrows results and URL state reflects the selection.
  test("topic filter narrows results and updates the URL", async ({ page }) => {
    await page.goto("/?fixture=150#/history");
    await expect(page.getByTestId("history-list")).toBeVisible();

    await page.getByTestId("filter-topic").selectOption("penguins");
    // Every nested topic heading is the penguins topic (date-first grouping).
    const topicHeadings = page.locator("section.date-group h3.topic-heading");
    await expect(topicHeadings.first()).toBeVisible();
    const slugs = await topicHeadings.evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-topic-slug") ?? ""),
    );
    expect(slugs.length).toBeGreaterThan(0);
    expect(slugs.every((s) => s === "penguins")).toBe(true);
    // URL search reflects the selection (shareable).
    await expect.poll(() => new URL(page.url()).search).toContain("topic=penguins");
  });

  // AC2: A shareable URL with ?topic= yields the pre-filtered view on load.
  test("shareable ?topic= URL loads pre-filtered", async ({ page }) => {
    await page.goto("/?fixture=150&topic=ai_models#/history");
    await expect(page.getByTestId("history-list")).toBeVisible();
    const topicHeadings = page.locator("section.date-group h3.topic-heading");
    await expect(topicHeadings.first()).toBeVisible();
    const slugs = await topicHeadings.evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-topic-slug") ?? ""),
    );
    expect(slugs.length).toBeGreaterThan(0);
    expect(slugs.every((s) => s === "ai_models")).toBe(true);
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
});
