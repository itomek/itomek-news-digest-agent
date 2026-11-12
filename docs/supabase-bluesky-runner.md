# Supabase Warp Core runner (prepared, not deployed)

Owner chose existing News Digest Supabase project and corrected cadence to hourly
on 2026-11-12. No dependency on Strix Halo or GitHub Actions. The existing TTS
function and audio automation are unrelated and must remain untouched.

The new `supabase/functions/bluesky-collect` Edge Function is review-only. Deploy
with JWT verification ON. It reads a verified roster from `BLUESKY_SOURCE_CONFIG`
(actors and relevance terms), never request content. It makes at most ten bounded
public Bluesky API requests, collects up to fifty entries each, filters the last
24 hours and returns explicitly unverified candidates. No model calls, posting or arbitrary source URLs are implemented. The follow-up
section below describes the prepared, not yet deployed persistence adapter.

Tests: `node --test supabase/functions/bluesky-collect/core.test.mjs` (five passed).
Deno hosted runtime has not yet been tested. No deployed function, new schema,
Vault entry or scheduler job was created.

Existing project has pg_cron and Vault; pg_net is absent. Existing jobs refresh
source health hourly and check missed digests daily. Preserve both.

Remaining activation work:
1. Verify a useful source roster (the posting account is not a news source).
2. Add private persistent candidate/history state with RLS and retention; do not
   repeatedly post the same story. Current URI deduplication is within-run only.
3. Establish owner-approved authenticated Cron invocation and credential storage;
   never use public anon access as the authority to publish or spend model funds.
4. Enable pg_net and a new hourly Cron job only once a complete secure function
   is ready; suggested schedule `17 * * * *` avoids the existing top-of-hour job.
5. Authorize the dedicated Bluesky app password in Supabase function secrets, and
   separately settle model provider/budget if generated summaries are desired.
6. Verify first hosted run and review sample candidates before enabling posting.

Official docs checked: https://supabase.com/docs/guides/functions/schedule-functions
and https://supabase.com/changelog.md. No applicable Edge Function breaking change
found in recent changelog entries. CLI v3 breaking change applies if CLI is used.

## Follow-up implementation (still local only)

Persistence adapter now submits canonical story-link hashes to an atomic unique
constraint (`ON CONFLICT DO NOTHING` through a service-role-only SQL RPC); linkless items use their AT
URI. A same-story cross-post is not inserted again, including across concurrent
runs. Shortened/redirected URLs are not resolved and can still evade this first
slice's deduplication; semantic deduplication remains editorial work.

The handler now requires both platform JWT verification and a dedicated random
scheduler token. Token comparison hashes both sides; missing/short configured
secrets fail closed. Server-only project key comes from the hosted runtime, never
retrieved or placed in source. A public anon JWT alone cannot trigger this worker.

Ten Node tests pass. SQL proposals are deliberately not migration files and have
not been applied or database-tested. Hosted Deno execution remains unverified.
No recurring job or database change was made.

### Owner credential handoff

Use Bluesky Settings > Privacy and Security > App Passwords for the dedicated
Warp Core account; create an app password without direct-message permission.
The owner enters it directly into Supabase Dashboard > Edge Functions > Secrets
for News Digest as `BLUESKY_APP_PASSWORD`, with `BLUESKY_IDENTIFIER` set to
`warp-core.bsky.social`. Do not paste it into chat, commits, SQL, logs or artifacts.
Dashboard: https://supabase.com/dashboard/project/eedfyviypptfpghyffip/functions/secrets

This flow still needs explicit owner authorization for the credential's storage
and intended public posting. There is no Bluesky connector or secure credential
form exposed here. The current collector does not consume that password and must
remain review-only until a separately tested publisher is ready.
