import { expect, type Page } from "@playwright/test";
import { base32Decode, generateTotp } from "../../src/lib/totp";

// Helper for specs that read REAL data from Supabase. Reads are RLS-gated to the
// `authenticated` role (see supabase/migrations/0006), so these specs need a genuine
// authenticated session at AAL2 — the same bar the app's gate enforces. That requires
// a dedicated test account with an enrolled TOTP factor:
//
//   MFA_TEST_EMAIL        the account's email
//   MFA_TEST_PASSWORD     its password
//   MFA_TEST_TOTP_SECRET  the base32 secret of its (already verified) TOTP factor
//
// Without all three the live specs skip — exactly like mfa.spec.ts. The fixture-mode
// history specs do NOT use this; they only need the auth gate to pass (seedSession).

const EMAIL = process.env.MFA_TEST_EMAIL;
const PASSWORD = process.env.MFA_TEST_PASSWORD;
const TOTP_SECRET = process.env.MFA_TEST_TOTP_SECRET;

export const LIVE_AUTH = Boolean(EMAIL && PASSWORD && TOTP_SECRET);
export const LIVE_AUTH_SKIP =
  "set MFA_TEST_EMAIL / MFA_TEST_PASSWORD / MFA_TEST_TOTP_SECRET to run live authenticated-read specs";

interface ClientWindow {
  __supabase: import("@supabase/supabase-js").SupabaseClient;
}

/**
 * Establish a real authenticated AAL2 session in the page's Supabase client:
 * sign in with password (factor 1), then challenge + verify the account's TOTP
 * factor (factor 2) using a code computed from the stored secret. supabase-js
 * persists the session to localStorage, so a subsequent `page.goto` boots the app
 * already authenticated and digest reads succeed under RLS.
 */
export async function signInAal2(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => !!(window as unknown as { __supabase?: unknown }).__supabase, {
    timeout: 15_000,
  });

  const signInErr = await page.evaluate(async ([email, password]) => {
    const client = (window as unknown as ClientWindow).__supabase;
    const { error } = await client.auth.signInWithPassword({ email, password });
    return error?.message ?? null;
  }, [EMAIL!, PASSWORD!] as const);
  expect(signInErr, "password sign-in (factor 1)").toBeNull();

  const factorId = await page.evaluate(async () => {
    const client = (window as unknown as ClientWindow).__supabase;
    const { data } = await client.auth.mfa.listFactors();
    return data?.totp?.find((f) => f.status === "verified")?.id ?? null;
  });
  expect(
    factorId,
    "the test account must have a verified TOTP factor matching MFA_TEST_TOTP_SECRET",
  ).not.toBeNull();

  // Step the session up to AAL2. Retry once in case the code lands right on a 30s
  // window boundary.
  let verifyErr = await challengeAndVerify(page, factorId!);
  if (verifyErr) {
    verifyErr = await challengeAndVerify(page, factorId!);
  }
  expect(verifyErr, "TOTP challenge + verify (factor 2)").toBeNull();

  // supabase-js persists the new AAL2 session to localStorage on the auth state
  // change. Wait for it to land before returning so callers can re-navigate and boot
  // the app already authenticated (a re-render is what surfaces digest content).
  await page.waitForFunction(
    () => {
      for (let i = 0; i < window.localStorage.length; i++) {
        if (window.localStorage.key(i)?.endsWith("-auth-token")) return true;
      }
      return false;
    },
    { timeout: 5_000 },
  );
}

async function challengeAndVerify(page: Page, factorId: string): Promise<string | null> {
  // Create the challenge first (a Supabase round-trip), THEN compute the code right
  // before verify — so the code and the verify share the same 30s window with minimal
  // skew, rather than spending the code's lifetime on the challenge round-trip.
  const challenge = await page.evaluate(async (fid) => {
    const client = (window as unknown as ClientWindow).__supabase;
    const res = await client.auth.mfa.challenge({ factorId: fid });
    if (res.error || !res.data) return { error: res.error?.message ?? "no challenge" } as const;
    return { challengeId: res.data.id } as const;
  }, factorId);
  if ("error" in challenge) return challenge.error ?? "no challenge";

  const code = await generateTotp(base32Decode(TOTP_SECRET!));
  return page.evaluate(async ([fid, challengeId, otp]) => {
    const client = (window as unknown as ClientWindow).__supabase;
    const verify = await client.auth.mfa.verify({ factorId: fid, challengeId, code: otp });
    return verify.error?.message ?? null;
  }, [factorId, challenge.challengeId, code] as const);
}
