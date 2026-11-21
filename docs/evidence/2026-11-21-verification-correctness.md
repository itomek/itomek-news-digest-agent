# Issue #162 correctness reconciliation

This change fixes local correctness gaps; it does not establish full semantic quality acceptance or production rollout.

## Corrections

- The versioned discovery and verification policy now requires all published and unresolved publications plus pending/leased decisions, without a history date cutoff. Fourteen-day wording was obsolete. Current-policy request fingerprints change accordingly.
- A guarded policy cutover migration updates SQL producer/validation settings to the matching worker policy. Deployment requires pausing the producer and draining discovery and live leases first; the migration leaves the producer paused. This migration has not been applied to production.
- Native evidence attribution must be a `bsky.app/profile/<frozen DID>/post/<frozen record key>` URL. Both collector percent-encoded DIDs and historical literal DIDs remain valid. Unrelated hosts, authors, post keys, query strings and handle-only attribution fail closed. A separate discovery article URL remains permitted.
- The immediate repost pre-send lookup now shares capture-time original validation. Exact URI/CID/author alone cannot authorize a newly restricted original: warning labels, blocked/private state, missing/malformed records and existing timestamp limits are checked again. Invalid originals enter manual review without a repost write. Network failures retain uncertain-outcome handling.

## Acceptance evidence

| Requirement | Executable evidence | Limit |
| --- | --- | --- |
| All published and unresolved history | `integration-tests/agent-verification.mjs`: exactly 66 records across pages of 50 and 16; ninety-day-old publications across accounts, all unresolved publication states, pending/leased inbox, changed old evidence invalidates hash | Disposable SQL fixture, not production history inspection |
| No history truncation | `verification-runtime.test.mjs`: all 75 records reach verification; later-page hash change and history over 500 KB defer before source acquisition or paid reservation | Structural input and fail-closed plumbing, not semantic judgment |
| Bounded transient lock recovery | #194 / `docs/verification-history-contention.md`; runtime/service regression suites | Real two-session concurrency requires separate loopback PostgreSQL; PGlite does not prove concurrent row locking |
| Exact native identity and pre-send publicness | `native-verification.test.mjs`, `_shared/adapters.test.mjs`, `_shared/sender.test.mjs` | Public API HTTP fixtures, no live original retrieval or publication |
| Captured source proof and safe retrieval | Existing source/transport/contract tests cover URL/redirect/private-address defenses, limits, raw hashes, quote/date bindings and political rejection | Bound quotes are provenance, not proof of natural-language entailment |
| Final submission rechecks | Existing SQL integration receipt/currentness, guarded submit/finalization and idempotency cases | No production deployment performed |

## Remaining semantic acceptance

Keep #162 open. Reconcile labeled evidence for same-event suppression across RSS, publisher articles and native reposts (including null repost text/summary), changed titles/URLs without a changed event, genuine material follow-ups with concrete change/dedup rationale, and nonmaterial follow-ups that defer. Unsupported claims, conflicting dates and private/political material must continue to fail editorial verification. Hand-authored model responses and request fingerprint tests cannot establish these judgments.

Draft sizing/rubric and held-out evaluation remain tracked in #164; alert behavior remains in #165. The closed #193 lock recovery work is already present through #194 and is not duplicated here.

## Local validation

- 599 Node tests passed using the workflow's unit-test file set, `--test-concurrency=2` and `umask 022` (the shell defaults to `0077`, which changes a permission-test fixture).
- `npm test --prefix integration-tests` passed, including the new full-history and guarded policy-cutover coverage.
- Deno 2.5.6 checks passed for `news-agent/index.ts` and `news-publish/index.ts`, using the system CA store for this environment.
- Independent diff review found no actionable issues; `git diff --check` passed.

The real independent-session PostgreSQL/PostgREST concurrency suites were not rerun locally because those services are unavailable here; they remain covered by the existing CI workflow.
