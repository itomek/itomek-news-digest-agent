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

    // At least one date group, with a date heading and a nested topic heading
    // (date-first grouping, #101).
    const groups = page.locator(".date-group");
    await expect(groups.first()).toBeVisible({ timeout: 15_000 });
    expect(await groups.count()).toBeGreaterThan(0);

    await expect(page.locator(".date-heading").first()).toBeVisible();
    await expect(page.locator(".topic-heading").first()).toBeVisible();
    await expect(page.locator(".digest-card").first()).toBeVisible();

    // Grouping invariant (date-first, #101): top-level date headings are sorted
    // descending across the page.
    const dates = await page
      .locator(".date-heading")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-date") ?? ""));
    const sortedDesc = [...dates].sort().reverse();
    expect(dates).toEqual(sortedDesc);
  });

  // AC: structured digests render summary + expandable items; legacy cards fall back.
  test("structured digest cards show summary and expandable items", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".digest-card").first()).toBeVisible({ timeout: 15_000 });

    // Tolerate data: some cards may be pre-#58 (content only), some structured.
    // For each card, assert it shows either a structured layout or a fallback body —
    // never neither.
    const cards = page.locator(".digest-card");
    const count = await cards.count();
    for (let i = 0; i < Math.min(count, 5); i++) {
      const card = cards.nth(i);
      const hasStructured = (await card.locator("details.digest-item").count()) > 0;
      const hasFallback = (await card.locator("p.digest-body").count()) > 0;
      // At least one rendering mode must be present.
      expect(hasStructured || hasFallback).toBe(true);
    }
  });

  // AC: structured items are <details> elements that can be expanded.
  test("structured digest items are expandable <details> elements", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".digest-card").first()).toBeVisible({ timeout: 15_000 });

    const firstStructured = page.locator("details.digest-item").first();
    // Only assert if structured cards exist on the page — graceful when data is all legacy.
    const hasStructured = (await firstStructured.count()) > 0;
    if (!hasStructured) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "No structured digest cards found (all rows are pre-#58 content-only)",
      });
      return;
    }

    // The item should be a <details> that can be opened.
    await expect(firstStructured).toBeVisible();
    const tagName = await firstStructured.evaluate((el) => el.tagName.toLowerCase());
    expect(tagName).toBe("details");

    // Clicking the <summary> opens the item.
    const summaryEl = firstStructured.locator("summary").first();
    await summaryEl.click();
    await expect(firstStructured).toHaveAttribute("open", "");
  });

  // AC: legacy (pre-#58) content-only cards still show their body text.
  test("legacy content-only digest cards still render body text", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".digest-card").first()).toBeVisible({ timeout: 15_000 });

    // Find any card with a p.digest-body (fallback). If structured rows dominate,
    // there may be none — that's fine; the test is a no-op rather than a false failure.
    const fallbackCards = page.locator("p.digest-body");
    const count = await fallbackCards.count();
    if (count === 0) return;

    for (let i = 0; i < Math.min(count, 3); i++) {
      const text = await fallbackCards.nth(i).textContent();
      expect((text ?? "").trim().length).toBeGreaterThan(0);
    }
  });
});
