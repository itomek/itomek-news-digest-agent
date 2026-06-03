import { expect, test } from "@playwright/test";

// AC: Unauthenticated users cannot access digest content — they see the password gate.
test("unauthenticated visitor sees an email + password gate, not digest content", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.getByTestId("auth-gate")).toBeVisible();
  await expect(page.getByTestId("password-form")).toBeVisible();

  // Email + password fields are present; the old magic-link button is gone.
  await expect(page.locator("#email")).toBeVisible();
  await expect(page.locator("#password")).toBeVisible();
  await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /magic link/i })).toHaveCount(0);

  // No digest content rendered for an unauthenticated session.
  await expect(page.getByTestId("digest-content")).toHaveCount(0);
  await expect(page.locator(".digest-card")).toHaveCount(0);
});

// AC: Wrong credentials surface a clear error (real Supabase, no mocks).
test("wrong password shows an error", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("password-form")).toBeVisible();

  await page.locator("#email").fill("nobody@example.com");
  await page.locator("#password").fill("definitely-not-the-password");
  await page.getByRole("button", { name: /sign in/i }).click();

  // Supabase returns "Invalid login credentials" for a bad email/password pair.
  const err = page.getByTestId("auth-error");
  await expect(err).toBeVisible();
  await expect(err).not.toBeEmpty();

  // Still on the gate, no digest content.
  await expect(page.getByTestId("auth-gate")).toBeVisible();
  await expect(page.getByTestId("digest-content")).toHaveCount(0);
});

// Client-side validation: a malformed email never reaches the network.
test("client-side validation rejects a malformed email", async ({ page }) => {
  await page.goto("/");
  await page.locator("#email").fill("not-an-email");
  await page.locator("#password").fill("longenoughpw");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByTestId("auth-error")).toContainText(/valid email/i);
});
