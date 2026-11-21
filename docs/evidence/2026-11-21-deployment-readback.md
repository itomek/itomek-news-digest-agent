# Guarded publication deployment and public readback — November 21

Read-only observations at approximately 21:52 UTC, compared with repository commit `34f60eb02ca95e7b1d8a998ef1f11f2942c7753b`. No deployment, production claim, model invocation or public write was performed. Supabase connector project inventory identified News Digest `eedfyviypptfpghyffip` as ACTIVE_HEALTHY. Source was retrieved with `get_edge_function`, configuration with `list_edge_functions`, and SQL definitions/privileges with catalog SELECTs.

## Current deployed files

| Function | Version / JWT | Bundle SHA-256 | Comparison with repository files |
|---|---|---|---|
| news-agent | 34 / true | `aca9c3fae09d4bcb63ddcdff9dc84a1ad8deb7f00dfb2be38a17c471d06b8d64` | 25/30 files byte-identical; five differences add history-lock contention classification, bounded retries and terminal deferral handling |
| news-curate | 8 / true | `fd427e1ace291315003eef90146c5df6e244b85e10495453bd9f5ae999197564` | 9/10 files byte-identical; bundled `bluesky-collect/store.mjs` predates the repository's DeepSeek dated-changelog key branch |
| news-publish | 14 / true | `21fa6aff6e763e8486e7b567674cc1a0f3942203cc077099b7399c7239ed6c9d` | 9/11 files byte-identical; same older store helper plus the deliberate index `WARPCORE_PUBLISH_ENABLED` false→true deployment override |

The five differing agent files are `gmail-alerts.mjs`, `verification-contract.mjs`, `hosted-application.mjs`, `verification-services.mjs`, and `verification-runtime.mjs`. They add the `history_lock_contention` reason, recognize history RPC SQLSTATE 55P03, retry at most three times inside the existing history deadline and defer on exhaustion. This is observed deployed drift, not an assertion that tracked HEAD contains or has accepted the change. Publisher and curator handlers and publication helpers otherwise match byte-exactly. The older store helper is inventory evidence; no claim that the publisher uses its collection-key branch is made here.

## Current SQL and permissions

`pg_get_functiondef` returned bodies matching repository SQL after whitespace normalization:

| Function | Matching repository artifact |
|---|---|
| `warpcore_agent_submit(uuid)` | `supabase/functions/news-agent/sql/agent-verification.sql` |
| `warpcore_curator_claim(integer)` | `supabase/migrations/20261112175929_warpcore_curator_inbox.sql` |
| `warpcore_claim_publication(text,text,text,jsonb)` | `supabase/migrations/20261118180116_warpcore_drain_without_hourly_quota.sql` |
| `warpcore_reserve_login(text)` | same drain-without-hourly-quota migration |
| `warpcore_mark_uncertain(text,text,text,jsonb)` | `supabase/migrations/20261112145946_warpcore_review_base.sql` |

For all five functions, `has_function_privilege` returned false for `anon` and `authenticated`, true for `service_role`. Current publication/login claims increment counters without a five/hour predicate, consistent with [PR #189](https://github.com/itomek/itomek-news-digest-agent/pull/189). The publication claim still requires exact hash/payload, prepared state, immutable approval and approved story, locking the record before moving to sending. These are current catalog observations, not live destructive permission/claim tests or a complete schema-parity audit.

## Fresh public record readbacks

Unauthenticated HTTPS retrieval returned HTTP 200. The pinned bot DID is `did:plc:pfq2p7n2oiiy2k4pv6xnsgdk`; fresh PLC directory resolution returned handle `warp-core.bsky.social` and PDS `https://discina.us-west.host.bsky.network`.

| Record | Fresh result compared with November 17 evidence |
|---|---|
| [GLM summary](https://bsky.app/profile/warp-core.bsky.social/post/3n2j6ehbk7sdg) | AppView getPosts returns exact bot URI and historical CID `bafyreibze45vs7emzuljl24wxgcno4icbazc6ivbgfvwihom2ajmo2jmz4`; text 240 characters, AMD URL facet byte range 156–240, createdAt `2026-11-17T13:43:36.995Z` |
| Native repost `at://did:plc:pfq2p7n2oiiy2k4pv6xnsgdk/app.bsky.feed.repost/3n2j6xnfhkc2y` | Authoritative PDS getRecord returns exact historical CID `bafyreiga2lv4jrp64g2tl6ofwiasepjscsrpxyazwjdrppl3jdps22rmju`, subject URI `at://did:plc:bz67dxqh5nmjl5it36xylqyy/app.bsky.feed.post/3mzxwb7hwgp2k`, subject CID `bafyreifufmuhox6rfmp2irvumdund32aqxeoux3uuv7np5gkfhozd7eq5e`, createdAt `2026-11-17T13:54:20.949Z`; payload contains only type, subject and createdAt |
| [Immediate llama.cpp publication](https://bsky.app/profile/warp-core.bsky.social/post/3n2jjfqgwfsef) | AppView returns exact historical CID `bafyreicmdlvn7nisiipjzxiys6472l5asi2gg553p2w2kbvzz7plumnb2q`, bot DID/handle, b12430 source URL facet and createdAt `2026-11-17T17:01:11.323Z` |

Matching record CIDs and identities corroborate retained payloads. This audit did not perform a new browser-rendering check, re-evaluate editorial support, replay an uncertain send, or prove every production concurrency failure case. Current database mutation tests belong in disposable PostgreSQL/PostgREST fixtures.
