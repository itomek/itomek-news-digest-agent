# Warp Core activation checklist (2026-11-12)

The merged base is not yet a running news feed. Source gathering and publishing
remain hard-disabled; the owner deferred source selection. TTS is separate.

## Connection

Create a dedicated app password in the posting account's Bluesky Settings >
Privacy and Security > App Passwords, with no direct-message permission. Enter
it directly in the existing project's Edge Functions Secrets page, never chat:
https://supabase.com/dashboard/project/eedfyviypptfpghyffip/functions/secrets

- `BLUESKY_APP_PASSWORD`: dedicated app password
- `BLUESKY_IDENTIFIER`: `warp-core.bsky.social`
- `BLUESKY_ACCOUNT_DID`: independently resolve and verify this handle's public DID

A tested server-only initializer resolves the public handle and DID document
before transmitting the password to its verified Bluesky-hosted PDS. It validates
the returned account DID. No redirects, automatic retries, credential logging or
persistent session tokens. One login per enabled hourly invocation (24/day under
normal schedule); rate-limit failure stops that run. No account login has been
performed. Existing static access-token mode remains supported internally but is
not the recommended unattended configuration.

## Hourly schedule

`supabase/schedules/install-disabled.sql` installs two INACTIVE jobs atomically:
collection at minute 17 and publication at minute 27 of each hour. They are separate
because editorial review is not instantaneous; the publisher reads only already
approved records. It refuses to overwrite existing names. It does not install
extensions, create secrets, change existing schedules or send HTTP requests.

Before activation, review/enable pg_net (currently absent) and provision distinct
random scheduler tokens (at least 32 characters) in BOTH Edge secrets and Vault:

| Edge secret | Vault name |
|---|---|
| `WARPCORE_CRON_TOKEN` | `warpcore_collect_cron_token` |
| `WARPCORE_PUBLISH_CRON_TOKEN` | `warpcore_publish_cron_token` |

Also store the existing enabled legacy public anon JWT in Vault under
`warpcore_gateway_anon_jwt`. It is only the gateway credential; the dedicated
secret remains required. Do not use a service-role key for scheduler requests.
The SQL command reads these privately at execution, never embeds their values.
Owner/dashboard secret entry is necessary because no safe secret-writing tool is
available in this thread. Missing/short values fail closed; no automatic retries.

Do not activate either job until the relevant function lock, approved sources,
editorial scope, operator identity and connection tests are deliberately reviewed.
A pg_net request ID means queued, NOT successful execution; inspect sanitized
status/error and function logs. Never print header or session values. A disabled
schedule or empty source roster is not a working feed.

## Curation still requires a decision

Implemented: public evidence collection interface, persistent dedup/provenance,
original-summary/significance/citation validation, immutable review snapshots,
trusted operator approval and create-only publisher with uncertainty reconciliation.
Not implemented/selected: an autonomous summarizing model or its budget; no model
spending is authorized here. Manual editorial review can produce the first posts
without a paid model. The owner's immutable Supabase Auth user ID must be verified
and explicitly allowed before the operator endpoint is unlocked. Do not create an
account, allow every authenticated user, or let a model approve its own sources.

This makes the remaining owner action concrete: securely save the dedicated app
password, then settle a small initial content/source scope and whether initial
summaries are manually reviewed or use an authorized model. Credentials alone do
not remove the content and activation gates.

References verified: https://supabase.com/docs/guides/functions/schedule-functions
and https://bsky.network/docs/rate-limits/ .
