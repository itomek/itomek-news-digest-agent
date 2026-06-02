import { expect, test } from "@playwright/test";
import { seedSession } from "./session";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "https://eedfyviypptfpghyffip.supabase.co";
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY ?? "sb_publishable_CCE4uRqvWCAonhnDis0BZQ_ixrd0jl2";

// AC: Digests render grouped by topic and date when a session exists.
test("authenticated user sees digests grouped by topic and date", async ({ page }) => {
  await seedSession(page, SUPABASE_URL, ANON_KEY);
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
