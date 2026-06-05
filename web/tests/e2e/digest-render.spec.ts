import { expect, test } from "@playwright/test";
import { LIVE_AUTH, LIVE_AUTH_SKIP, signInAal2 } from "./live-auth";

// Reads real digests from Supabase, so it needs a genuine authenticated (AAL2)
// session — RLS gates reads to the `authenticated` role.
test.describe("digest render (live authenticated reads)", () => {
  test.skip(!LIVE_AUTH, LIVE_AUTH_SKIP);

  test.beforeEach(async ({ page }) => {
    await signInAal2(page);
  });

  // AC: Digests render grouped by topic and date when authenticated.
  test("authenticated user sees digests grouped by topic and date", async ({ page }) => {
    await page.goto("/");

    // Digest content region renders (not the auth gate).
    await expect(page.getByTestId("digest-content")).toBeVisible();
    await expect(page.getByTestId("auth-gate")).toHaveCount(0);

    // At least one topic group with a topic heading and a date heading.
    const groups = page.locator(".topic-group");
    await expect(groups.first()).toBeVisible({ timeout: 15_000 });
    expect(await groups.count()).toBeGreaterThan(0);

    await expect(page.locator(".topic-heading").first()).toBeVisible();
    await expect(page.locator(".date-heading").first()).toBeVisible();
    await expect(page.locator(".digest-card").first()).toBeVisible();

    // Grouping invariant: each topic-group carries a slug, and date headings carry
    // dates that are sorted descending within the group.
    const firstGroupDates = await page
      .locator(".topic-group")
      .first()
      .locator(".date-heading")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-date") ?? ""));
    const sortedDesc = [...firstGroupDates].sort().reverse();
    expect(firstGroupDates).toEqual(sortedDesc);
  });
});
