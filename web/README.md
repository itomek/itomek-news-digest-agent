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

This is a single-user app. Login is **email + password** (factor 1) enforced with **TOTP
authenticator MFA** (factor 2, AAL2). Digest content is only rendered once the session
reaches AAL2. New signups are disabled at the Supabase project level — only the one
pre-existing account can ever log in.

`src/lib/auth.ts` holds all wrappers (sign-in, MFA enroll, challenge, change-password) and
the pure gate predicates (`hasValidSession`, `isMfaSatisfied`, `nextGateStep`). Data access
is RLS-gated with the anon key regardless of auth state.

### Login flow

1. **Password step** — enter email + password.
2. **Enroll step (first login only)** — a QR code and manual secret are displayed. Scan with
   an authenticator app (e.g. Bitwarden, Authenticator), then enter the 6-digit code. The
   session steps up to AAL2 and the app reloads to show digests.
3. **Challenge step (returning logins)** — enter the current 6-digit TOTP code from your
   authenticator app.
4. **Digests** — rendered only at AAL2.

The Account section (accessible from the home page) lets you change the password without
re-entering the old one, which is useful after bootstrapping with a temporary password.

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

1. **Authentication > Sign In / Providers > Email** — confirm Email provider is **on** and
   "Allow new users to sign up" is **OFF**. Only the pre-seeded account can log in.
2. **Authentication > Multi-Factor** — enable **TOTP** (Time-based One-Time Password). The
   app will not force enrollment if this is off.
3. **Bootstrap the owner account password** — run the following SQL in the Supabase SQL
   editor (or via the Supabase MCP `execute_sql` tool), replacing the placeholders:
   ```sql
   update auth.users
   set encrypted_password = crypt('TEMP_PW', gen_salt('bf'))
   where email = 'owner@example.com';
   ```
4. **First login** — open the app, sign in with the email and the temporary password. The
   enroll step appears automatically (QR code + manual secret). Scan with your authenticator
   app, enter the 6-digit code to reach AAL2.
5. **Change the temporary password** — once in, use the Account section to set a permanent
   password.
