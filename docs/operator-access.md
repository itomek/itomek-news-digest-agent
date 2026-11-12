# Operator workflow and deployment receipt

The model/source-neutral base now includes a server-side review API, not a browser dashboard. No operator identities have been selected. Deployed news-operator v1 requires platform JWT and has a hardcoded empty allowlist, so every request is denied before data access. Live checks: no JWT ->401; valid public anon JWT ->403 operator_access_not_configured. No auth users, credentials, subscriptions or source selections were created.

When explicitly configured later, identity must be verified through this project's Auth getUser and matched against immutable user IDs. Actions are bounded list, preview, approve and reject; there is no publish/config/SQL/URL action and no ambient-cookie authentication.

Preview reads only server-held public evidence and saves an immutable review packet plus exact publication record. Approval/rejection accepts snapshot ID, expected hash and revision, never replacement evidence/text. Decision is atomic, records reviewer ID/time and prevents stale overwrites. Canonical JSON hashing survives JSONB key ordering. At most one pending review exists per account/story. Rejection means rejection of that pending review, not revocation of previously approved or published content; response explicitly says publicationRevoked:false.

Applied server-only review schema migration: 20261112151146_warpcore_operator_reviews. Table empty, RLS on, anon/authenticated SELECT/EXECUTE denied. No identities/fixtures seeded. Existing collector remains code-locked to empty sources; publisher remains code-locked disabled. No Warpcore cron exists and existing TTS/cron are untouched.

Verified in standard public CI run https://github.com/itomek/itomek-news-digest-agent/actions/runs/43244915278 : 64 tests, real PostgreSQL lock contention, PostgREST RPC and role denial, frozen preview, exact approval, stale-decision rejection and reviewer audit. Legacy Python lint/format/unit tests also passed (run43244915287). Deno tests/type checks passed locally. Independent security review cleared dormant deployment; live authenticated owner access remains intentionally unconfigured and untested.

Before any posts: establish source/editorial scope, authorized operator identity/access, secure Bluesky session setup, dedicated scheduler secrets and an explicit activation change. No paid model was selected and the base does not invent an automated editorial policy.
