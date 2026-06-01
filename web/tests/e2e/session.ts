import type { Page } from "@playwright/test";

// Supabase-js v2 persists the session in localStorage under
// `sb-<projectRef>-auth-token`. The home page guard only checks that a
// structurally-valid, non-expired session exists (hasValidSession).
//
// We set the session's access_token to the project's PUBLISHABLE/ANON key. When a
// session is present, supabase-js sends access_token as the Bearer; PostgREST
// accepts the publishable key and resolves to the anon role, so RLS-gated reads
// (anon SELECT on digests/topics) succeed against REAL Supabase — no mocks, no
// forged JWT. This exercises the authenticated render path end-to-end.

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
