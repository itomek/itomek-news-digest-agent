# Production setup receipt, 2026-11-12

This supersedes earlier readiness notes saying no production schema/functions exist.

## Applied
Existing project: eedfyviypptfpghyffip. No new paid project/branch/resources.
- Migration `warpcore_review_base`, recorded hosted version `20261112145946`.
- Three new empty tables: warpcore_stories, warpcore_candidates, warpcore_publications.
- Tested server-only SECURITY INVOKER RPCs and immutable-record trigger.
- `news-collect` v1, verify_jwt=true; deployed entrypoint hardcodes NEWS_SOURCE_CONFIG=[] (no selected source).
- `news-publish` v1, verify_jwt=true; deployed entrypoint hardcodes WARPCORE_PUBLISH_ENABLED=false.
- Earlier permanently inert warpcore-smoke remains installed.

Activation requires an explicit reviewed code change, not merely a stray environment variable. No scheduler or dedicated tokens were created. No Bluesky credentials were obtained/stored and no posts sent.

## Verified after setup
- All three tables contain zero rows and have RLS enabled.
- anon/authenticated cannot SELECT them; cannot EXECUTE any new RPC.
- All new RPCs are SECURITY INVOKER, not SECURITY DEFINER.
- Collector/publisher reject unauthenticated requests at gateway with 401.
- With existing enabled public anon JWT they reject at dedicated-token gate with 401. Public anon table request also returns permission denied. Public key used transiently, not persisted.
- Existing TTS remains version1, verify_jwt=true, identical code hash ba44a29547870ead5391dee787650afb43fe1e6de7d5130bd155ad8fb49e8e1c.
- Existing cron jobs remain news_digest_refresh_source_health (hourly) and news_digest_check_missed_digests (daily16:00 UTC), unchanged; no Warpcore cron.
- Advisors add only expected INFO notices for RLS-enabled tables without public policies. Existing unrelated advisories are unchanged.

Migration file was initially created using official Supabase CLI3.1.0, then synchronized to the exact version assigned by hosted apply_migration to avoid later replay. SQL proposal comments in the source are historical; this receipt and hosted history establish application status. No existing tables/data/permissions, auth settings or TTS function were modified.

## Still intentionally inactive
Sources, automated editorial policy/model, trusted operator approval access, Bluesky session provisioning, dedicated scheduler secrets, and hourly collection/publication schedule. Default-deny schema is intentional: do not resolve the RLS INFO notices by adding public policies. Required next configuration can happen without changing existing audio.
