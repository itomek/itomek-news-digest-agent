import { expect, test } from "@playwright/test";
import { base32Decode, generateTotp } from "../../src/lib/totp";

// TRUE end-to-end MFA: sign in with a password (factor 1), enroll a TOTP factor,
// compute the code from the secret Supabase returns (RFC-6238, src/lib/totp.ts), verify,
// and assert the session reaches aal2.
//
// This needs a REAL account, so it only runs when MFA_TEST_EMAIL / MFA_TEST_PASSWORD are
// provided in the environment. Without them it is skipped: the TOTP computation itself is
// proven deterministically by tests/unit/totp.test.ts (RFC 4226/6238 vectors), and the
// challenge+verify wrapper is exercised by the gate. Enrolling against live Supabase in CI
// is flaky and would leave dangling factors, so we gate it behind explicit credentials.

const EMAIL = process.env.MFA_TEST_EMAIL;
const PASSWORD = process.env.MFA_TEST_PASSWORD;

test.describe("TOTP MFA end-to-end (live, credentialed)", () => {
  test.skip(!EMAIL || !PASSWORD, "set MFA_TEST_EMAIL / MFA_TEST_PASSWORD to run the live MFA flow");

  test("enroll + compute code + verify reaches aal2", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => !!(window as unknown as { __supabase?: unknown }).__supabase, {
      timeout: 15_000,
    });

    // Sign in (factor 1) using the app's own client.
    const signedIn = await page.evaluate(
      async ([email, password]) => {
        const client = (window as unknown as {
          __supabase: import("@supabase/supabase-js").SupabaseClient;
        }).__supabase;
        const { error } = await client.auth.signInWithPassword({ email, password });
        return error?.message ?? null;
      },
      [EMAIL!, PASSWORD!] as const,
    );
    expect(signedIn).toBeNull();

    // Enroll a fresh TOTP factor; capture id + secret.
    const enroll = await page.evaluate(async () => {
      const client = (window as unknown as {
        __supabase: import("@supabase/supabase-js").SupabaseClient;
      }).__supabase;
      const { data, error } = await client.auth.mfa.enroll({ factorType: "totp" });
      if (error || !data) return { error: error?.message ?? "no data" } as const;
      return { factorId: data.id, secret: data.totp.secret } as const;
    });
    if ("error" in enroll) throw new Error(`enroll failed: ${enroll.error}`);

    // Compute the current TOTP code from the secret (our RFC-6238 implementation).
    const code = await generateTotp(base32Decode(enroll.secret));

    // Challenge + verify -> step up to aal2.
    const verifyErr = await page.evaluate(
      async ([factorId, otp]) => {
        const client = (window as unknown as {
          __supabase: import("@supabase/supabase-js").SupabaseClient;
        }).__supabase;
        const challenge = await client.auth.mfa.challenge({ factorId });
        if (challenge.error || !challenge.data) return challenge.error?.message ?? "no challenge";
        const verify = await client.auth.mfa.verify({
          factorId,
          challengeId: challenge.data.id,
          code: otp,
        });
        return verify.error?.message ?? null;
      },
      [enroll.factorId, code] as const,
    );
    expect(verifyErr).toBeNull();

    const level = await page.evaluate(async () => {
      const client = (window as unknown as {
        __supabase: import("@supabase/supabase-js").SupabaseClient;
      }).__supabase;
      const { data } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
      return data?.currentLevel ?? null;
    });
    expect(level).toBe("aal2");

    // Clean up so the account isn't left with a dangling factor.
    await page.evaluate(async (factorId) => {
      const client = (window as unknown as {
        __supabase: import("@supabase/supabase-js").SupabaseClient;
      }).__supabase;
      await client.auth.mfa.unenroll({ factorId });
    }, enroll.factorId);
  });
});
