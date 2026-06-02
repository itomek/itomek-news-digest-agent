import { expect, test } from "@playwright/test";

// AC / security backstop: the anon client cannot WRITE to digests (RLS).
// Uses the app's OWN shipped @supabase/supabase-js client (exposed on
// window.__supabase, anon key only). Real Supabase, no mocks.
test("anon client cannot insert into digests (RLS blocks writes)", async ({ page }) => {
  await page.goto("/");

  // Wait for the app bundle to attach the client.
  await page.waitForFunction(() => !!(window as unknown as { __supabase?: unknown }).__supabase, {
    timeout: 15_000,
  });

  const result = await page.evaluate(async () => {
    const client = (window as unknown as { __supabase: import("@supabase/supabase-js").SupabaseClient }).__supabase;
    const { error } = await client.from("digests").insert({
      topic_slug: "ai_models",
      content: "rls-test-should-fail",
      cadence: "24h",
      digest_date: "2000-01-01",
      sources_used: [],
      prompt_version: "rlstest",
    });
    return { code: error?.code ?? null, message: error?.message ?? null };
  });

  // Postgres RLS violation surfaces as code 42501.
  expect(result.code).toBe("42501");
  expect(result.message).toMatch(/row-level security/i);
});
