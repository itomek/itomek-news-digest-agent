# News Digest Web App

Mobile-first reading app for the News Digest Agent. Vanilla TypeScript + Vite (no
framework, no JSX), Supabase for auth and data, deployed to Cloudflare Pages.

## Stack

- **Build:** Vite + TypeScript, hand-rolled DOM, a tiny hash router (`src/router.ts`).
- **Data:** `@supabase/supabase-js` using the **anon/publishable key only**. All reads
  are RLS-gated. The service_role key is NEVER shipped to the browser.
- **Auth:** Supabase magic link (email OTP, no password). Sign-ups are restricted by an
  email allowlist (see below).
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
| `npm run test:unit`| Vitest (pure logic: allowlist, grouping, query, auth) |
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
    auth.ts          # magic-link sign-in/out + hasValidSession guard
    allowlist.ts     # pure isEmailAllowed (client-side UX check only)
    group.ts         # pure groupDigestsByTopicAndDate
    query.ts         # pure query-shape builders
    types.ts         # shared data shapes
  views/
    digest-card.ts   # renders one digest; has a .playback-slot mount point + registerPlaybackControls hook (#11)
    digest-list.ts   # grouped render
    auth-gate.ts     # login form / unauthenticated gate
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

## Auth allowlist (security boundary)

Sign-ups are restricted to emails in the **`public.digest_allowlist`** table.

- **DB trigger (source of truth):** `supabase/migrations/0003_auth_allowlist.sql` adds the
  table and an `after insert on auth.users` trigger that deletes any user whose email is
  not allowlisted. This is enforced in Postgres and cannot be bypassed by the client.
- **Edge Function (optional, cleaner):** `supabase/functions/auth-allowlist/index.ts` can be
  wired as a Supabase Auth "Before user created" hook to reject non-allowlisted emails
  *before* the row is created. It reads the same `digest_allowlist` table.
- **Client-side check:** `src/lib/allowlist.ts` is a UX nicety only — never the boundary.

Add an allowed email:

```sql
insert into public.digest_allowlist (email, note) values ('you@example.com', 'owner');
```

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

1. Apply migration `0003_auth_allowlist.sql` (`supabase db push` or the SQL editor).
2. Insert your email into `digest_allowlist`.
3. In the Supabase dashboard, **Authentication > URL Configuration**, set the Site URL and
   add the Cloudflare Pages URL (and `http://localhost:5173` for local) to **Redirect URLs**
   so magic links return to the app.
4. (Optional) wire `auth-allowlist` as a "Before user created" Auth hook.
5. On iPhone: open the Cloudflare Pages URL in Safari, enter your allowlisted email, tap the
   magic link in Mail — it opens the app authenticated.
