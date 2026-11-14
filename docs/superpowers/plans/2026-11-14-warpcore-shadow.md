# Warp Core shadow evaluation implementation plan

Goal: begin #160/#164 with a credential-free, nonpublishing contract for comparing agent decisions with owner-reviewed real-world cases.

Architecture: Deno-compatible pure modules beside the current functions. Policy is versioned data; an evaluator scores supplied model decisions without revealing expected labels in the model input. No deployment entrypoint or database writer is included.

Constraints: no paid requests, credentials, live writes or production enablement. Existing collection, drain, publishing and cron remain unchanged. Real-story fixtures are discovery inputs, not verified evidence or authority. This first slice does not select a production framework or prove model quality.

- [x] Add tests for hidden expected labels, missing/duplicate/unknown responses and real negative PyTorch case.
- [x] Add strict evaluation and request-envelope modules; require explicit model allowlist and output token cap.
- [x] Add real public candidate fixtures with provenance and editorial expected labels, including owner's Helion rejection.
- [x] Test locally and run existing JavaScript suite. Document unrun hosted/model and end-to-end stages.
- [x] Independent review, fix findings, commit and draft PR only.

Verification: 170 JavaScript tests and 10 timer tests passed. Legacy Python suite could not start because pytest is unavailable. Hosted execution, paid model evaluation and rendered Bluesky tests remain unrun.

## Second slice
- [x] Add test-first resumable scan/review core with fixed timestamp, terminal-page gate and atomic-save dependency.
- [x] Prevent automatic model replay after crash, timeout, malformed response or persistence conflict.
- [x] Separate unlabeled discovery input from evaluation gold labels.
- [x] Add explicit-off OpenRouter-only transport with injected fetch, usage validation, timeout and response-size bounds; no real calls.
- [x] Run final full JavaScript suite and independent review. No hosted database adapter or production cutover in this slice.

Second-slice verification: 191 JavaScript tests passed, including an offline workflow/request/transport composition test. Previous commit CI and isolated validation both passed on GitHub. No actual OpenRouter request or hosted scheduler ran.

## Third slice: isolated durable shadow store

Build on the existing PostgreSQL stack rather than add a second queue vendor.
Keep proposed SQL outside `supabase/migrations` so this draft cannot install it
through a normal migration deployment. No Edge Function entrypoint or live
scheduler is added. The database contract will fence stale workers with lease
tokens and revision checks. Cost reservations must serialize against shared
budget rows; uncertain requests retain their full reservation. Settlements record
actual spend, including overages, without silently freeing uncertain requests.
This is infrastructure validation, not proof of editorial/model quality.

- [x] Test-first SQL contract for shadow run state and cost ledger.
- [x] Embedded SQL tests for permissions, invalid states and idempotency.
- [x] Real PostgreSQL contention tests for leases and shared budgets in CI.
- [x] Independent review and aggregate tests; publish only to existing draft PR.

Third-slice local checks: 191 JavaScript tests, 10 timer tests, and the full
embedded SQL suite passed. Real PostgreSQL contention is configured for CI but
not run locally (no PostgreSQL server here). Independent review identified and
fixed shared-day dispatch blocking and changed-hash retry within one checkpoint;
midnight dispatch is also refused. Production workflow transition enforcement,
normalized candidate persistence and real model-quality evaluation remain gates.

## Fourth slice: disabled injected runtime composition

Use the existing Deno-compatible workflow and parameterized-query seam instead of
adding a database SDK, credentials or deployable Edge Function. This connects
proven components while leaving production activation explicitly out of scope.
The runtime is off by default, acquires a durable lease, persists reviewing state,
reserves credit against an exact HTTP-body hash, records dispatch once, and settles
known cost independently from editorial success. Any uncertain persistence result
stops dispatch/replay. All HTTP in tests is injected synthetic transport.

- [x] Test-first disabled runtime and exact-request serialization contract.
- [x] Real embedded SQL composition with fake responses and uncertain failures.
- [x] Independent review, aggregate checks, existing draft PR only.

Fourth-slice verification: 198 JavaScript tests, 10 timer tests and the full embedded
SQL suite passed, including actual SQL with fake model HTTP. Independent reviewer
reran runtime and composition tests. Remaining-lease-time robustness is documented
as a hosted-worker gate; no model quality or deployment readiness is claimed.

## Fifth slice: safe source seams

Prepare real-story shadow inputs without invoking a model or deploying anything.
Reuse the operator contract's fixed-timestamp, full keyset candidate scan as a
parameterized read-only adapter. Add a separate disabled HTTP acquisition seam
for exact captured public evidence URLs on explicit trusted hostname allowlists.
Fetched content remains untrusted, and successful retrieval is never a factual
verification attestation. No ranking/publication decision is automated here.

- [x] Test-first candidate adapter and >100-candidate embedded SQL coverage.
- [x] Disabled, bounded exact-URL source acquisition and adversarial tests.
- [x] Independent review and aggregate verification; draft PR only.

Fifth-slice verification: 211 JavaScript tests and the complete embedded SQL suite
passed. Candidate scan exercised 211 eligible records across 100/100/11/empty
pages. Independent review passed acquisition and candidate integration tests.
No real evidence fetch, live model call, or factual verification is claimed.
