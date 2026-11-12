# Warpcore readiness, 2026-11-12

## Implemented and verified
- Source-neutral collection contract and existing Bluesky adapter, with no selected sources.
- Authenticated collector and default-disabled publisher entrypoints; body cannot select drafts/config/accounts.
- Server-only exact-record approval, immutable records, bounded queue, atomic claim proposal, create-only write, reconciliation and durable manual-review/fair queue rotation.
- DID/PDS and session verification before sending; no password/session provisioning or refresh.
- 51 mocked unit/composition tests pass under Node and Deno; Deno checks both entrypoints.
- PGlite executes proposed SQL and verifies approval/claim state transitions, dedup/provenance, immutability and anonymous access denial.
- Hosted permanently inert `warpcore-smoke` verifies gateway 401 without JWT and disabled 200 with enabled public anon JWT. TTS v1/hash and existing cron unchanged.

## Not complete / not represented as verified
- Genuine multi-session PostgreSQL contention: an isolated PostgreSQL 17.6 process initialized but the sandbox denied Unix-domain socket creation (Operation not permitted), so startup aborted. No concurrency assertions ran. No sandbox/security settings were changed to evade that restriction.
- Hosted PostgREST integration: project has no development branches. Creating one incurs charges; no paid branch was created. Production test fixtures would share the live project and were not introduced.
- Production migration/function deployment, credentials/session provisioning, approval workflow, hourly cron and source selection are inactive. Only the inert smoke endpoint exists live.
- Editorial selection/verification/summarization and additional RSS/HN/newsletter adapters are not implemented. Keyword filtering is not a curator. Do not describe this draft as a running news service.

## Safe next gates
1. Run schema and overlapping transaction tests in an authorized disposable PostgreSQL/Supabase test environment; verify PostgREST RPC/relationship mapping and role privileges there.
2. Review/merge the draft changes and turn SQL proposals into CLI-generated migrations; retain recovery copies and check existing project advisors separately.
3. Establish approved source/editorial scope, a trusted exact-record approval path and session setup. No plaintext credentials in chat, repository, SQL or logs.
4. Deploy collector idle and publisher disabled, verify both JWT and dedicated-token rejection paths; then test with synthetic records in isolation.
5. Enable scheduling and any public posting only after explicit scope/reliability gates are met. No extra paid commitment is assumed.
