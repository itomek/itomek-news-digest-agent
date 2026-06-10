import type { Page } from "@playwright/test";

// GATE-ONLY seeded session. Supabase-js v2 persists the session in localStorage
// under `sb-<projectRef>-auth-token`; the app's gate treats a structurally-valid,
// non-expired session whose access_token can't be decoded as a JWT as "MFA satisfied"
// (see src/lib/auth.ts getAalState), so this is enough to pass the auth gate.
//
// IMPORTANT: the access_token here is the PUBLISHABLE/ANON key, so any actual reads
// resolve to the `anon` role at PostgREST. Since reads are RLS-gated to the
// `authenticated` role (supabase/migrations/0006), seeded sessions CANNOT read live
// digests. Use this ONLY for specs that don't hit the network for data — i.e. the
// `?fixture=` history specs and the unauthenticated-gate checks. Specs that read real
// data must use signInAal2() from ./live-auth instead.

function projectRef(supabaseUrl: string): string {
  return new URL(supabaseUrl).host.split(".")[0];
}

export async function seedSession(page: Page, supabaseUrl: string, anonKey: string): Promise<void> {
  const ref = projectRef(supabaseUrl);
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const session = {
    access_token: anonKey,
    refresh_token: "test-refresh",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: expiresAt,
    user: { id: "test-user", email: "owner@example.com", role: "authenticated" },
  };
  // addInitScript runs before any page script, so the session is present when
  // supabase-js initializes.
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [`sb-${ref}-auth-token`, JSON.stringify(session)] as const,
  );
}
