import type { Session, SupabaseClient } from "@supabase/supabase-js";

// Magic-link auth + a pure session-guard predicate.

/** Pure predicate: is this session usable right now? Unit-tested. */
export function hasValidSession(session: Session | null): boolean {
  if (!session) return false;
  if (!session.access_token) return false;
  if (typeof session.expires_at === "number") {
    return session.expires_at > Math.floor(Date.now() / 1000);
  }
  return true;
}

/** Send a magic link. The allowlist trigger rejects non-allowlisted sign-ups. */
export async function sendMagicLink(
  client: SupabaseClient,
  email: string,
  emailRedirectTo: string,
): Promise<{ error: string | null }> {
  const { error } = await client.auth.signInWithOtp({
    email: email.trim(),
    options: { emailRedirectTo, shouldCreateUser: true },
  });
  return { error: error ? error.message : null };
}

export async function getCurrentSession(client: SupabaseClient): Promise<Session | null> {
  const { data } = await client.auth.getSession();
  return data.session;
}

export async function signOut(client: SupabaseClient): Promise<void> {
  await client.auth.signOut();
}
