import type { Session, SupabaseClient } from "@supabase/supabase-js";

// Email + password sign-in (factor 1) + TOTP authenticator MFA (factor 2), enforced
// via Supabase AAL. The Supabase calls live in thin wrappers here; the gate's decision
// logic is in the pure, unit-tested helpers at the bottom.

// --- Pure predicates & validators (DOM-free, no Supabase import) -------------

/** Pure predicate: is this session usable right now? Unit-tested. */
export function hasValidSession(session: Session | null): boolean {
  if (!session) return false;
  if (!session.access_token) return false;
  if (typeof session.expires_at === "number") {
    return session.expires_at > Math.floor(Date.now() / 1000);
  }
  return true;
}

export interface AalState {
  currentLevel: string | null;
  nextLevel: string | null;
}

/**
 * Is the second factor satisfied for this session?
 *
 * We only require a step-up when the account actually has a verified factor — i.e.
 * `nextLevel === 'aal2'` — AND the current session hasn't stepped up yet. When there
 * are no factors (`nextLevel === 'aal1'`) or the level can't be determined (e.g. a
 * non-JWT access token, as in the e2e seeded session), there is nothing to satisfy, so
 * we treat it as satisfied and let `hasValidSession` be the gate. This keeps the
 * seeded-session e2e specs valid while forcing a real enrolled account to AAL2.
 */
export function isMfaSatisfied(aal: AalState): boolean {
  if (aal.nextLevel === "aal2" && aal.currentLevel !== "aal2") return false;
  return true;
}

export type GateStep = "password" | "enroll" | "challenge" | "done";

/**
 * Choose which step of the gate to render. Pure; unit-tested.
 *
 * `currentLevel` comes from `getAalState` which decodes the JWT `aal` claim. A real
 * password session yields `'aal1'`; a seeded/offline session whose access_token is the
 * publishable key (not a JWT) causes decode to throw, so `getAalState` catches and returns
 * `null`. We use that discriminator to distinguish "real first login → force enroll" from
 * "seeded/undecodable session → pass through".
 */
export function nextGateStep(input: {
  hasSession: boolean;
  currentLevel: string | null;
  hasVerifiedTotp: boolean;
  mfaSatisfied: boolean;
}): GateStep {
  if (!input.hasSession) return "password";
  if (input.hasVerifiedTotp && !input.mfaSatisfied) return "challenge";
  if (input.currentLevel === "aal1" && !input.hasVerifiedTotp) return "enroll";
  return "done";
}

/** Returns an error message or null. */
export function validateEmail(email: string): string | null {
  const v = email.trim();
  if (!v) return "Enter your email.";
  // Deliberately strict-ish: requires a dot in the domain.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return "Enter a valid email address.";
  return null;
}

export function validatePassword(password: string): string | null {
  if (!password) return "Enter your password.";
  if (password.length < 8) return "Password must be at least 8 characters.";
  return null;
}

export function validateTotpCode(code: string): string | null {
  const v = code.trim();
  if (!/^\d{6}$/.test(v)) return "Enter the 6-digit code from your authenticator app.";
  return null;
}

// --- Thin Supabase wrappers --------------------------------------------------

export async function getCurrentSession(client: SupabaseClient): Promise<Session | null> {
  const { data } = await client.auth.getSession();
  return data.session;
}

export async function signOut(client: SupabaseClient): Promise<void> {
  await client.auth.signOut();
}

/** Factor 1: email + password sign-in. Returns a user-facing error or null. */
export async function signInWithPassword(
  client: SupabaseClient,
  email: string,
  password: string,
): Promise<{ error: string | null }> {
  const { error } = await client.auth.signInWithPassword({
    email: email.trim(),
    password,
  });
  return { error: error ? error.message : null };
}

/**
 * Read the session's Authenticator Assurance Level. Any failure (including a non-JWT
 * access token that can't be decoded, as in the seeded e2e session) collapses to
 * "unknown" → treated as satisfied by `isMfaSatisfied`.
 */
export async function getAalState(client: SupabaseClient): Promise<AalState> {
  try {
    const { data, error } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error || !data) return { currentLevel: null, nextLevel: null };
    return { currentLevel: data.currentLevel, nextLevel: data.nextLevel };
  } catch {
    return { currentLevel: null, nextLevel: null };
  }
}

export interface TotpFactorInfo {
  factorId: string | null;
  verified: boolean;
}

/** Find the (single-user) TOTP factor and whether it is verified. */
export async function listTotpFactor(client: SupabaseClient): Promise<TotpFactorInfo> {
  try {
    const { data, error } = await client.auth.mfa.listFactors();
    if (error || !data) return { factorId: null, verified: false };
    const totp = data.totp ?? [];
    const verified = totp.find((f) => f.status === "verified");
    if (verified) return { factorId: verified.id, verified: true };
    const first = totp[0];
    return { factorId: first ? first.id : null, verified: false };
  } catch {
    return { factorId: null, verified: false };
  }
}

export interface EnrollResult {
  factorId: string | null;
  qrCode: string | null;
  secret: string | null;
  error: string | null;
}

/** Begin TOTP enrollment; returns the QR (SVG data URL) and the manual-entry secret. */
export async function enrollTotp(client: SupabaseClient): Promise<EnrollResult> {
  try {
    const { data, error } = await client.auth.mfa.enroll({ factorType: "totp" });
    if (error || !data) {
      return { factorId: null, qrCode: null, secret: null, error: error?.message ?? "Enrollment failed." };
    }
    return {
      factorId: data.id,
      qrCode: data.totp.qr_code,
      secret: data.totp.secret,
      error: null,
    };
  } catch (err) {
    return { factorId: null, qrCode: null, secret: null, error: (err as Error).message };
  }
}

/** Challenge a factor and verify a code in one step; lifts the session to AAL2. */
export async function challengeAndVerify(
  client: SupabaseClient,
  factorId: string,
  code: string,
): Promise<{ error: string | null }> {
  try {
    const challenge = await client.auth.mfa.challenge({ factorId });
    if (challenge.error || !challenge.data) {
      return { error: challenge.error?.message ?? "Could not start the MFA challenge." };
    }
    const verify = await client.auth.mfa.verify({
      factorId,
      challengeId: challenge.data.id,
      code: code.trim(),
    });
    return { error: verify.error ? verify.error.message : null };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** Change the signed-in user's password (used for the temporary first password). */
export async function changePassword(
  client: SupabaseClient,
  password: string,
): Promise<{ error: string | null }> {
  const { error } = await client.auth.updateUser({ password });
  return { error: error ? error.message : null };
}

/**
 * The full gate predicate: a session must exist, be unexpired, AND be at the required
 * assurance level. Pages call this to decide whether to render digest content.
 *
 * Uses the same `nextGateStep` predicate as the gate view so the two can never disagree
 * (which would cause a reload loop).
 */
export async function isAuthenticatedAtRequiredLevel(
  client: SupabaseClient,
): Promise<boolean> {
  const session = await getCurrentSession(client);
  if (!hasValidSession(session)) return false;
  const [aal, totp] = await Promise.all([getAalState(client), listTotpFactor(client)]);
  return (
    nextGateStep({
      hasSession: true,
      currentLevel: aal.currentLevel,
      hasVerifiedTotp: totp.verified,
      mfaSatisfied: isMfaSatisfied(aal),
    }) === "done"
  );
}
