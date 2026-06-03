---
type: plan
source-issue: 52
repo: itomek/itomek-news-digest-agent
title: "Replace magic-link auth with email + password + TOTP MFA"
created: 2026-06-02
status: in-progress
work_type: code-feature
complexity: standard
tdd_required: true
suggested_team_size: 1
estimated_files_changed: 5
test_command: "ssh tomas@t-nx-radeon 'bash -lc \"cd ~/ndw-issue52 && npm run test:unit && npm run test:e2e\"'"
build_command: "ssh tomas@t-nx-radeon 'bash -lc \"cd ~/ndw-issue52 && npm run build\"'"
lint_command: "ssh tomas@t-nx-radeon 'bash -lc \"cd ~/ndw-issue52 && npm run lint\"'"
branch: feat/auth-password-mfa
reflection_iterations: 1
agents_used: [planning, execution, validation]
---

# Plan — Issue #52: email + password + TOTP MFA (replace magic link)

## Status: RESUME of an ~90% complete implementation

A prior interrupted session implemented most of this issue. The work is committed as a
checkpoint at `116a63cf` on `feat/auth-password-mfa`. Already DONE and verified by reading:

- AC#1 email+password gate, magic-link removed (no `sendMagicLink`/`signInWithOtp` left in `web/src`). ✓
- AC#3 returning-user TOTP challenge (challenge step + `challengeAndVerify`). ✓
- AC#5 in-app change-password (Account section in `home.ts` + `changePassword`). ✓
- `lib/totp.ts` correct RFC-4226/6238 TOTP via WebCrypto, proven by RFC-vector unit tests. ✓
- `lib/auth.ts` thin Supabase wrappers + pure predicates; `history.ts` + `home.ts` share the
  `isAuthenticatedAtRequiredLevel` guard. ✓

## THE DEFECT to fix (AC#2 + AC#4) — first-login enrollment is unreachable

`nextGateStep` returns `"enroll"` only for `{hasSession:true, hasVerifiedTotp:false,
mfaSatisfied:false}`. That state is impossible in production: `mfaSatisfied` is false only
when `getAuthenticatorAssuranceLevel().nextLevel === 'aal2'`, which Supabase sets ONLY when a
verified factor already exists → `hasVerifiedTotp` is then true. So the enroll branch is dead
code, and a fresh real account (aal1, no factor) → `isMfaSatisfied` true → digests render at
aal1, enrollment never offered. A unit test feeds the impossible state directly and passes —
green test, unreachable feature.

### Fix: forced-enroll gate, driven off `currentLevel` (user-approved approach)

The discriminator that separates a REAL no-factor account from the e2e SEEDED session:
`getAuthenticatorAssuranceLevel()` decodes the JWT `aal` claim → real password session yields
`currentLevel:'aal1'`; the seeded session's `access_token` is the publishable key (not a JWT),
so decode throws and `getAalState` (which catches) returns `currentLevel:null`. Drive the
enroll decision off that.

**`lib/auth.ts` — change `nextGateStep` signature + logic:**

```ts
export function nextGateStep(input: {
  hasSession: boolean;
  currentLevel: string | null;   // from getAalState; null = undecodable (seeded/offline)
  hasVerifiedTotp: boolean;
  mfaSatisfied: boolean;
}): GateStep {
  if (!input.hasSession) return "password";
  if (input.hasVerifiedTotp && !input.mfaSatisfied) return "challenge"; // returning user, step up
  if (input.currentLevel === "aal1" && !input.hasVerifiedTotp) return "enroll"; // real first login
  return "done"; // already aal2, OR undecodable seeded/offline session
}
```

**`lib/auth.ts` — make the page guard use the same predicate (so home/history block a
no-factor real account but let seeded sessions through):**

```ts
export async function isAuthenticatedAtRequiredLevel(client: SupabaseClient): Promise<boolean> {
  const session = await getCurrentSession(client);
  if (!hasValidSession(session)) return false;
  const [aal, totp] = await Promise.all([getAalState(client), listTotpFactor(client)]);
  return nextGateStep({
    hasSession: true,
    currentLevel: aal.currentLevel,
    hasVerifiedTotp: totp.verified,
    mfaSatisfied: isMfaSatisfied(aal),
  }) === "done";
}
```

**`views/auth-gate.ts` — pass `currentLevel` into `nextGateStep` (one line):**
`step = nextGateStep({ hasSession, currentLevel: aal.currentLevel, hasVerifiedTotp: totp.verified, mfaSatisfied: isMfaSatisfied(aal) });`

Guard and gate now share one predicate, so they cannot disagree → no reload loop. Full first
login: password → renderGate recomputes → `enroll` (currentLevel 'aal1', no factor) → QR +
secret + verify → reload → now aal2 → `done` → digests.

Truth table (the states that ACTUALLY occur — encode these in tests):
| scenario | hasSession | currentLevel | hasVerifiedTotp | mfaSatisfied | step |
|---|---|---|---|---|---|
| logged out | false | – | – | – | password |
| real fresh account | true | aal1 | false | true | **enroll** |
| returning, has factor, aal1 | true | aal1 | true | false | challenge |
| stepped up | true | aal2 | true | true | done |
| seeded e2e / undecodable | true | null | false | true | done |

## TDD task list (tests FIRST, then implement to green)

1. **Rewrite `nextGateStep` unit tests** (`web/tests/unit/auth.test.ts`) to the new 4-field
   signature and the REAL reachable states above. Delete the old impossible-state test. The
   must-have case (would have caught the bug): real fresh account
   `{hasSession:true, currentLevel:'aal1', hasVerifiedTotp:false, mfaSatisfied:true}` → `enroll`;
   and seeded `{...currentLevel:null...}` → `done`. Keep `hasValidSession`, `isMfaSatisfied`,
   validators tests as-is.
2. Implement the `nextGateStep` + `isAuthenticatedAtRequiredLevel` changes in `lib/auth.ts` and
   the one-line `currentLevel` pass-through in `views/auth-gate.ts` → unit green.
3. **Finish `web/README.md`**: the lower "## Auth (single user)" + "One-time Supabase Auth
   configuration" sections still describe magic link. Rewrite to: email+password (factor 1) +
   enforced TOTP MFA (factor 2, AAL2); first login forces enrollment; signups disabled at the
   project level; bootstrap = set a temp password on the existing user via pgcrypto, log in,
   enroll authenticator, change password in-app; dashboard one-time: Email/password provider on,
   new signups OFF, TOTP MFA enabled (Authentication → Multi-Factor).
4. **Extend the live MFA e2e** (`web/tests/e2e/mfa.spec.ts`, credential-gated by
   `MFA_TEST_EMAIL`/`MFA_TEST_PASSWORD`): after sign-in with a no-factor account, assert the gate
   renders the enroll step (`mfa-qr` + `mfa-secret` visible) and `digest-content` is absent —
   proving AC#2 + AC#4 forced-enroll end-to-end. Keep the existing enroll→compute→verify→aal2
   assertion + factor cleanup.

## Validation tiers

- **Local (teammate, fast loop)** in the worktree: `cd web && npm install && npm run test:unit &&
  npm run lint && npm run build`. Unit + types + build prove the fix; no browser needed.
- **Real-world (orchestrator) on radeon** (`ssh tomas@t-nx-radeon`, see [[radeon-web-testing]]):
  rsync to `~/ndw-issue52`, recreate `web/.env` (VITE_SUPABASE_URL + publishable anon key — the
  rsync `--delete` wipes it), then:
  - `npm run test:e2e` — INCLUDING the seeded specs (digest-render/history/playback/rls). These
    passing IS the empirical proof the `currentLevel:null` discriminator keeps seeded sessions
    rendering. **If they break**, the decode-throws assumption is wrong → fall back to a
    listFactors-success discriminator (tri-state `listTotpFactor`) and re-run.
  - Lighthouse mobile @390×844 ≥90 (AC#6).
  - Live MFA: with TOTP MFA enabled in the dashboard (human) + a temp password bootstrapped via
    Supabase MCP, run `MFA_TEST_EMAIL=… MFA_TEST_PASSWORD=… npm run test:e2e -- mfa.spec.ts` to
    prove reaching aal2 + the forced-enroll gate (AC#2/#3/#4 live).

## Human checkpoints (orchestrator-mediated)

- Supabase dashboard (USER): TOTP MFA enabled; email/password provider on; new signups OFF.
- Temp password bootstrap (orchestrator via Supabase MCP `execute_sql`, pgcrypto):
  `update auth.users set encrypted_password = crypt(:pw, gen_salt('bf')) where email = :owner;`

## Acceptance criteria → evidence
- AC#1 email+password, magic-link gone → done; e2e auth-gate spec + grep-clean.
- AC#2 first-login enrollment → forced-enroll fix; live mfa.spec enroll-step assertion.
- AC#3 returning challenge → challenge step + challengeAndVerify; live mfa.spec aal2.
- AC#4 digests only at aal2 → unified gate/guard predicate; seeded specs (aal1-null) still render,
  real aal1 blocked.
- AC#5 change password → Account section; manual/live check.
- AC#6 Lighthouse ≥90 → radeon Lighthouse.
- AC#7 unit+e2e green on radeon + CI green → radeon run + web.yml on the PR.

## Risks
- decode-throws assumption for the seeded token (see fallback above) — the seeded e2e specs are
  the gate.
- Reload mid-enrollment re-enrolls a fresh factor (new secret each time). Acceptable for
  single-user bootstrap; not blocking.
- Live MFA enroll needs the dashboard toggle + temp password (human/orchestrator checkpoints).
