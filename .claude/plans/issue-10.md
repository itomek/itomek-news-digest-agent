---
type: plan
source-issue: 10
repo: itomek/itomek-news-digest-agent
title: "Build Supabase-hosted digest web app with authentication"
created: 2026-06-01
status: in-progress
work_type: code-feature
complexity: complex
tdd_required: true
suggested_team_size: 3
estimated_files_changed: 30
test_command: "ssh tomas@t-nx-radeon 'bash -lc \"cd ~/ndw-issue10 && npm run test:unit && npx playwright test\"'"
build_command: "ssh tomas@t-nx-radeon 'bash -lc \"cd ~/ndw-issue10 && npm run build\"'"
lint_command: "ssh tomas@t-nx-radeon 'bash -lc \"cd ~/ndw-issue10 && npm run lint\"'"
branch: feat/issue-10-web-app
reflection_iterations: 1
agents_used: [planning, execution, validation]
---

# Plan — Issue #10: Supabase-hosted digest web app with authentication

## Goal

Build a deployable, mobile-first web app (`web/`) that authenticates a single user via
Supabase Auth magic link (email allowlist enforced), reads digests through the anon
publishable key gated by RLS, and renders them grouped by topic and date. Ship a CI
workflow that builds, tests, and deploys to Cloudflare Pages. Scaffold clean, disjoint
extension points so issues #11 (TTS) and #12 (history) can be built in parallel without
editing shared files.

## Repo / environment facts established during exploration

- Stack decision: **vanilla TS + Vite, no framework, no JSX**. Hand-rolled DOM + a tiny
  hash router. `vite.config.ts` only `.ts` config file allowed.
- Live Supabase project `eedfyviypptfpghyffip` (us-east-2). Schema matches §3.1:
  `digests`, `digest_topics`, `system_logs` with RLS enabled. Verified: anon publishable
  key can SELECT digests, and anon INSERT is rejected with Postgres `42501`
  (row-level-security violation) — so the RLS integration assertion is real.
- Seeded test data: 4 digests across 2 topics (`ai_models` 3 dates, `local_news` 1 date)
  so grouping-by-topic-and-date is exercised against real rows. Topic `local_news` added
  (enabled) for that purpose.
- No edge functions exist yet — the allowlist function is greenfield.
- Test machine radeon: node v20.20.2, npm 10.8.2 (via nvm, requires `bash -lc`),
  `google-chrome` at `/usr/bin/google-chrome`.

## Architecture / extension points (critical — #11 and #12 build in parallel on this branch)

```
web/
  index.html                 # single page; root #app, CSP meta, viewport
  vite.config.ts             # build + vitest config
  tsconfig.json
  package.json               # scripts: dev build preview lint test:unit test:e2e
  .env / .env.example / .gitignore
  src/
    main.ts                  # bootstrap + tiny hash router (routes table; stub-friendly)
    router.ts                # route registry — pages register; main.ts does not change to add pages
    lib/
      supabase.ts            # client + fetchDigests / fetchTopics + grouping helpers (#12 APPENDS here)
      auth.ts                # magic-link signIn / signOut / session guard predicate
      allowlist.ts           # pure isEmailAllowed(email, list) — shared logic mirrors Edge Function
      group.ts               # pure groupDigestsByTopicAndDate (unit-tested)
      query.ts               # pure query-param builders (unit-tested)
    views/
      digest-card.ts         # renders one digest + .playback-slot mount point + mountPlaybackControls hook (#11)
      digest-list.ts         # renders grouped list
      auth-gate.ts           # login form / gate; redirects unauthenticated to login
    pages/
      home.ts                # home view (auth gate + digest list)
      history.ts             # STUB renderHistory(root, supabase) — #12 fills in
    styles.css               # minimal mobile-first CSS (Lighthouse >=90)
  tests/
    unit/*.test.ts           # vitest: allowlist, grouping, query builders, session guard
    e2e/*.spec.ts            # playwright: unauth redirect, grouped render w/ session, anon RLS write blocked
    e2e/playwright.config.ts
supabase/
  functions/auth-allowlist/index.ts   # Edge Function: reject non-allowlisted on auth.users insert
  migrations/0003_auth_allowlist.sql   # digest_allowlist table + trigger calling the check
.github/workflows/web.yml              # build + test + Cloudflare Pages deploy (gated on secrets)
```

Collision-avoidance contract:
- #11 (TTS) touches only: `src/lib/tts.ts` (new), `src/components/playback.ts` (new), and
  implements the `mountPlaybackControls` hook. It mounts into `.playback-slot` in each card.
  It does NOT edit `main.ts`, `router.ts`, or `digest-card.ts` core.
- #12 (history) touches only: `src/pages/history.ts` (fills the stub) and APPENDS
  history-specific query functions to `src/lib/supabase.ts`. The `#/history` route is already
  wired, so it does NOT edit `main.ts` / `router.ts`.

## Allowlist design decision

Use a **`digest_allowlist` table** (email text PK, note text, created_at) plus a Postgres
trigger function on `auth.users` AFTER INSERT that deletes the just-inserted user when the
email is not present in the allowlist. This is robust (DB-enforced, survives client bypass)
and does not depend on an Edge Function being invoked. We ALSO ship an Edge Function
`auth-allowlist` as documented in §8 / the issue file-list (callable as an Auth Hook "before
user created" hook if the human prefers the hook route) so both options are available. The
table is the source of truth either way. Browser-side, `lib/allowlist.ts` provides the same
pure predicate for a fast client-side UX rejection (defense in depth, not the security
boundary). Document this clearly in `web/README.md`.

The RLS-blocked-write integration test gives us the security backstop proof; the allowlist
trigger gives us the sign-up gate. Live magic-link send/click is a human checkpoint
(requires a real mailbox + Supabase SMTP/redirect config).

## TDD task breakdown (write failing tests first, implement to green)

1. Scaffold `web/` (package.json, vite, tsconfig, env files, gitignore). No logic yet.
2. UNIT (red→green):
   - `allowlist.test.ts` → `isEmailAllowed` (case-insensitive, trims, rejects empty/non-list).
   - `group.test.ts` → `groupDigestsByTopicAndDate` (orders topics, dates desc, shape).
   - `query.test.ts` → query-param builders (select/order strings for digests + topics).
   - `auth.test.ts` → `hasValidSession` predicate (null session, expired, valid).
3. Implement `lib/*` to green.
4. Implement views + pages + router + main + styles + index.html.
5. INTEGRATION (Playwright against `vite preview` of the built app, real Supabase):
   - unauthenticated user sees login gate, NOT digest content.
   - with an injected session (set supabase auth storage), digests render grouped by
     topic + date headers from real seeded rows.
   - anon client cannot write to `digests` (RLS) — call `.insert(...)` via the live client
     in-page and assert the error code/path.
6. Supabase migration `0003_auth_allowlist.sql` + Edge Function `auth-allowlist`.
7. `.github/workflows/web.yml` — build, test:unit, playwright, deploy to Cloudflare Pages
   gated on `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`.
8. `web/README.md` — setup, env vars, extension points for #11/#12, Cloudflare deploy + Supabase Auth config steps.

## Validation

Run on radeon: `npm install && npm run build && npm run test:unit && playwright test`.
Then a code-review pass for high-confidence (>=80) bugs/security/convention issues; fix
Critical only; re-run; max 3 iterations. Lighthouse (>=90 mobile @390x844) is the
orchestrator's checkpoint — we build to hit it (minimal CSS, no framework, system fonts,
no blocking resources, semantic HTML).

## Acceptance criteria mapping

- App accessible via URL → buildable `dist/` + `web.yml` deploy (live deploy = orchestrator/human).
- Magic-link auth + non-allowlisted rejected → `auth.ts` flow + `0003` trigger + Edge Function (live send = human).
- Digests grouped by topic+date → `group.ts` + `digest-list.ts`, proven by unit + e2e.
- Unauth cannot access content → `auth-gate.ts` + e2e redirect test.
- Lighthouse >=90 → minimal mobile-first build (orchestrator verifies).
- CI green → `web.yml` runs unit + e2e on PR.
