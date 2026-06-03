# News Digest Web App

Mobile-first reading app for the News Digest Agent. Vanilla TypeScript + Vite (no
framework, no JSX), Supabase for auth and data, deployed to Cloudflare Pages.

## Stack

- **Build:** Vite + TypeScript, hand-rolled DOM, a tiny hash router (`src/router.ts`).
- **Data:** `@supabase/supabase-js` using the **anon/publishable key only**. All reads
  are RLS-gated. The service_role key is NEVER shipped to the browser.
- **Auth:** Supabase email + password (factor 1) with enforced **TOTP authenticator MFA**
  (factor 2, AAL2). No email anywhere in the login path. Sign-ups are disabled at the
  project level (see below).
- **Tests:** Vitest (unit) + Playwright (integration, real Supabase — no mocks).

## Setup

```bash
cd web
cp .env.example .env   # fill in the values below
npm install
npm run dev            # http://localhost:5173
```

### Environment variables

| Var                     | Purpose                                         |
| ----------------------- | ----------------------------------------------- |
| `VITE_SUPABASE_URL`     | Supabase project URL                            |
| `VITE_SUPABASE_ANON_KEY`| Publishable/anon key (browser-safe, RLS-gated)  |

`.env` is gitignored. Never put the service_role key here.

## Scripts

| Script           | What it does                                          |
| ---------------- | ----------------------------------------------------- |
| `npm run dev`      | Vite dev server                                       |
| `npm run build`    | Type-check + production build to `dist/`              |
| `npm run preview`  | Serve the built app on port 4173                      |
| `npm run lint`     | ESLint + `tsc --noEmit`                               |
| `npm run test:unit`| Vitest (pure logic: auth/MFA gate, TOTP, grouping, query) |
| `npm run test:e2e` | Playwright against the built app (real Supabase)      |

## Architecture & extension points

The app is intentionally split so issues **#11 (TTS)** and **#12 (history)** can be built
in parallel without editing the same files.

```
src/
  main.ts            # bootstrap; declares routes ONCE. Do not edit to add a page.
  router.ts          # tiny hash router; routes register here
  lib/
    supabase.ts      # client + fetchDigests / fetchTopics  (#12 APPENDS queries below the marker)
    auth.ts          # password sign-in + TOTP MFA wrappers + pure gate predicates
    totp.ts          # RFC-6238 TOTP (test-only; computes codes from an enrollment secret)
    group.ts         # pure groupDigestsByTopicAndDate
    query.ts         # pure query-shape builders
    types.ts         # shared data shapes
  views/
    digest-card.ts   # renders one digest; has a .playback-slot mount point + registerPlaybackControls hook (#11)
    digest-list.ts   # grouped render
    auth-gate.ts     # multi-step gate: password -> enroll|challenge TOTP -> AAL2
  pages/
    home.ts          # today's digests (auth gate + list)
    history.ts       # STUB — #12 fills renderHistory(root, client)
```

**#11 (TTS)** should touch only: a new `src/lib/tts.ts`, a new `src/components/playback.ts`,
and call `registerPlaybackControls(fn)` from `views/digest-card.ts` (imported once in
`main.ts`). It mounts its UI into the `.playback-slot` element each card renders. It must
NOT edit `main.ts`, `router.ts`, or the core of `digest-card.ts`.

**#12 (history)** should touch only: `src/pages/history.ts` (fill the stub) and APPEND
history-specific queries to `src/lib/supabase.ts` below the documented marker. The
`#/history` route is already wired in `main.ts` to the stub, so it must NOT edit
`main.ts` / `router.ts`.

## Auth (single user)

This is a single-user app. Access is controlled by **disabling new signups** at the Supabase
project level — only the one pre-existing account can ever log in. Login is a passwordless
**magic link** (`sendMagicLink` uses `shouldCreateUser: false`, so unknown emails are rejected
rather than created). There is no allowlist table or hook — migration `0005` removed the
allowlist machinery that earlier versions (0003/0004) used to gate multi-user signups.

`src/lib/auth.ts` holds the magic-link send + the `hasValidSession` guard. Data access is
RLS-gated with the anon key regardless of auth method.

## Deploy (Cloudflare Pages)

CI (`.github/workflows/web.yml`) builds, lints, runs unit + e2e, and on push to `main`
deploys `web/dist` to Cloudflare Pages. The deploy step is gated on repo secrets
`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` and is skipped when they are absent.

Manual deploy:

```bash
cd web
npm run build
npx wrangler pages deploy dist --project-name=news-digest-web
```

### One-time Supabase Auth configuration (human checkpoint)

1. Create your account once (sign in with your email while signups are still on), then in the
   Supabase dashboard, **Authentication > Sign In / Providers > Email**, turn **off**
   "Allow new users to sign up". From then on only your account can log in.
2. In **Authentication > URL Configuration**, set the **Site URL** to the Cloudflare Pages URL
   and add it (plus `http://localhost:5173` for local dev) to **Redirect URLs** so magic links
   return to the app instead of the default `http://localhost:3000`.
3. On iPhone: open the Cloudflare Pages URL in Safari, enter your email, tap the magic link in
   Mail — it opens the app authenticated.
