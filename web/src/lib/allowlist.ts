// Pure email-allowlist logic. Shared shape with the Supabase trigger /
// Edge Function (supabase/functions/auth-allowlist). This client-side check is a
// fast UX rejection only — the real security boundary is the DB trigger.

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isEmailAllowed(email: string, allowlist: readonly string[]): boolean {
  const candidate = normalizeEmail(email);
  if (!candidate) return false;
  return allowlist.some((entry) => normalizeEmail(entry) === candidate);
}
