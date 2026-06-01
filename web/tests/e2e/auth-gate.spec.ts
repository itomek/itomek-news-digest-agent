import { expect, test } from "@playwright/test";

// AC: Unauthenticated users cannot access digest content — they see the login gate.
test("unauthenticated visitor sees the login gate, not digest content", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("auth-gate")).toBeVisible();
  await expect(page.getByRole("button", { name: /send magic link/i })).toBeVisible();

  // No digest content rendered for an unauthenticated session.
  await expect(page.getByTestId("digest-content")).toHaveCount(0);
  await expect(page.locator(".digest-card")).toHaveCount(0);
});
