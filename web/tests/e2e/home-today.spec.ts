import { expect, test } from "@playwright/test";
import { LIVE_AUTH, LIVE_AUTH_SKIP, signInAal2 } from "./live-auth";

// Live authenticated tests for the home page today-only filter (issue #100).
// These specs read real digests from Supabase and require a genuine AAL2 session.
// Run with:
//   MFA_TEST_EMAIL=... MFA_TEST_PASSWORD=... MFA_TEST_TOTP_SECRET=... npx playwright test home-today
test.describe("home today-only digest view (live authenticated reads)", () => {
  test.skip(!LIVE_AUTH, LIVE_AUTH_SKIP);

  test.beforeEach(async ({ page }) => {
    await signInAal2(page);
  });

  // AC: Only today's digests are shown — no older digest dates appear.
  test("home shows only today's digests (no older dates)", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("digest-content")).toBeVisible();
    await expect(page.getByTestId("auth-gate")).toHaveCount(0);

    // Wait for digests to load (or empty state to appear).
    await page.waitForSelector(".digest-list", { timeout: 15_000 });

    const dateHeadings = page.locator(".date-heading");
    const count = await dateHeadings.count();

    // If there are date headings, every one must be today in Eastern time.
    if (count > 0) {
      const eastern = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
      }).format(new Date());

      const dates = await dateHeadings.evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-date") ?? ""),
      );
      for (const d of dates) {
        expect(d).toBe(eastern);
      }
    }
  });

  // AC: When there are no today's digests, the clean empty state renders.
  test("empty state shows 'No news items were found.' when no today digests", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("digest-content")).toBeVisible();
    await page.waitForSelector(".digest-list", { timeout: 15_000 });

    const groups = page.locator(".topic-group");
    const empty = page.locator(".empty-state");

    // Either topic groups exist (today has digests) or the empty state shows.
    const groupCount = await groups.count();
    const emptyCount = await empty.count();
    expect(groupCount + emptyCount).toBeGreaterThan(0);

    if (groupCount === 0) {
      await expect(empty).toHaveText("No news items were found.");
    }
  });

  // AC: "Nothing to report" filler content does NOT appear on the home screen.
  test("filler 'nothing to report' content is suppressed", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("digest-content")).toBeVisible();
    await page.waitForSelector(".digest-list", { timeout: 15_000 });

    // No digest body should contain the known filler sentinel phrases.
    const bodies = await page.locator(".digest-body").allTextContents();
    for (const body of bodies) {
      const lower = body.toLowerCase();
      expect(lower).not.toContain("were reported by curated sources");
      expect(lower).not.toMatch(/^no new /);
      expect(lower).not.toMatch(/^nothing /);
      expect(lower).not.toMatch(/^there were no /);
    }
  });

  // Screenshot recipe for the orchestrator:
  // 1. signInAal2(page)
  // 2. await page.goto("/")
  // 3. await page.waitForSelector(".digest-list", { timeout: 15_000 })
  // 4. await page.screenshot({ path: "home-today.png", fullPage: true })
  // Expected: digest cards with today's date, OR the "No news items were found." empty state.
  // Must NOT contain any date heading other than today's Eastern date.
});
