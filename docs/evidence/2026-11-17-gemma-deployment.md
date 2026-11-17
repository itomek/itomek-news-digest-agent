# Gemma deployment — November 17

The owner directs deployment with an inexpensive American model, excludes NVIDIA and Meta from further use, and accepts minor writing/model imperfections rather than a perfection-based launch hold. The operator selects `google/gemma-4-26b-a4b-it` through PrimeIntellect and shipped actual generated records. Earlier proposed formal precision/recall targets are not claimed owner-agreed or achieved. Public-source, account identity, hard platform limits, source attribution, spending and no-duplicate/no-replay controls remain enforced.

## Route and boundaries

- Exact route `primeintellect/bf16`, provider `PrimeIntellect`, new immutable discovery profile `2026-11-17.8`, coded schema v4, reasoning disabled.
- Current routing prices 0.10/0.30 per million input/output tokens, request fee capped at zero, no fallback, supported parameters required and ZDR without safety retention.
- Advertised context 262144 and maximum completion 32768; requests use at most 4096 output tokens and 16 review candidates.
- Conservative full-context/full-provider-output reservation: 0.036045 OpenRouter credits. Existing daily/lifetime limits remain 2/19.99.
- The old `2026-11-16.1` Gemma quote/profile remains historical data; its earlier 0.06/0.18 routing prices are not used as current prices.

Verification V8 adds a trusted server UTC clock and date window to system instructions while preserving existing source/quotation/identity/date/history proofs and the 300-grapheme/3000-byte complete-post guard. The prompt's budget includes actual URLs, attribution and spacing. Historical V1–V7 request formats remain recorded; no prior ledger is reset.

Active JS model selection and private SQL selection allow only GPT-oss and Gemma, with Gemma selected explicitly. Fresh NVIDIA/Meta requests and reservations are rejected, including before pilot ledger access. Their profiles, prior requests and unknown financial holds remain historical records; late accounting is not disabled.

## Verification

All 539 Node tests and Deno checking pass. The 37-script embedded suite and additional Gemma native/ordinary/GitHub receipt flows pass. Independent review confirms the exact three-function upgrade and active model CHECK. Artifact SHA-256: `4ac184c8ec56afc063ed8ef7f15a85025e2a8c58dedeb3f0d5e826344afdff53`.

These static tests use fabricated provider responses. Deployment, fresh capability/privacy/funding checks and actual Gemma samples are recorded separately below. No new infrastructure, subscription, account or credential is needed.

## Deployed and published checkpoint

`news-agent` v21 is deployed with Gemma, producer/verification/submission enabled, exclusive agent submissions and minute continuation cron. The owner explicitly approved “Ship it” and confirms the old Dot task is off; that task retirement is owner-reported, not independently schedule-tool verified.

Publisher request 842 returned HTTP 200, processed two records and reported both published. The [GLM ordinary post](https://bsky.app/profile/warp-core.bsky.social/post/3n2j6ehbk7sdg) has 240 characters and 0.0057869 credits of verification cost, with public AppView and read-only UI confirmation. The native Verano repost cost 0.0028064 credits to verify and has authoritative public PDS readback. Exact record identities and CIDs are retained in the [publication evidence](2026-11-17-scheduled-discovery-quality.md#gemma-cutover-and-first-publications). These are verification charges, not total pipeline costs.

The next discovery run failed on timeout at 64/654 assessments, revision 18, with 0.0060952 known spent and 0.036045 unknown held credits. Owner-CAS workflow quarantine advanced it to revision 19, deferred/blocked; it remains a failed incomplete cycle, not full Gemma coverage.

The timeout migration SHA-256 `29e311d58bb8a6feeb369a0b7c5c8d5a654cd72f1a51b4c7dad2645d1e5df958` and 429 migration SHA-256 `83149e07682919750b0a3f5d653a1ce874b922f51b8c053b73495eef0bcf7032` were applied. One eligible verification 429 was advanced. All eight unknown attempts and the complete budget were exactly unchanged before/after: 0.625054 held / 0.6044672 spent credits. Readback found zero blocking discovery runs and zero unquarantined uncertain verifier jobs; producer, verification, submission and cron were restored, with Gemma unchanged.

Exact future Gemma/PrimeIntellect upstream shared-pool 429 continuation waits at least five minutes beyond lease expiry, honors longer Retry-After and is bounded to ten per UTC day. It selects different work, excludes uncertain stories across parent runs and never replays or resolves the failed request's billing. Generic unknown failures still stop for owner recovery; the timeout helper remains private and manual. The updated embedded suite passed 38 scripts / 41 PASS checks and independent reviews. No numeric quality threshold, sustained unattended reliability or full Gemma scan is claimed.

Install order: `verification-rate-limit.sql` follows `verification-quarantine.sql`; the private manual timeout helper is defined in `billing-quarantine.sql`. The owner action records workflow recovery, never automatic billing resolution.

Normal cron request 867 at 14:25:00.131302 UTC returned HTTP 200 with `{mode:"verification",status:"deferred",reason:"evidence_or_history_unavailable"}`. This confirms resumed work on another candidate after recovery, with an honest evidence/history deferral; it is not another publication.
