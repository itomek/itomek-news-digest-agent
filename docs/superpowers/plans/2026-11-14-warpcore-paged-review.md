# Durable paged review implementation plan

Goal: complete #161's durable full-review core through existing PR #166, then implement remaining hosted producer contracts before merge. Production enablement, paid calls and cutover require their existing separate approvals.

Architecture: keep private shadow run/accounting tables; add normalized candidate and decision rows. Compact checkpoints use storageKind=paged-v1, candidateCount/reviewedCount, fixed identity, cursor, phase, revision and activeBatch. No aggregate JSON backlog is loaded by the new runtime. Legacy workflow remains a tested reference.

## Database/runtime interface
Existing claim/load/reserve/dispatch/settle functions remain. Admin seeds compact runs with limits; workers cannot provision budgets.
- paged_append(run,lease,revision,page): returns new compact state, NULL on stale CAS. Nonempty pages append at most 100 sorted unique candidates; empty page ends scan.
- paged_begin(run,lease,revision,size): returns {state,batch}, NULL on stale CAS. Freezes next ordered batch as reviewing, or marks complete when no remaining candidates.
- paged_commit(run,lease,revision,decisions): returns state, requires settled matching attempt and exact next batch.
- paged_uncertain(run,lease,revision): returns state; preserves batch and accounting.
All functions enforce lease at final write and atomic row/checkpoint writes; no automatic uncertain replay. SQL stays outside migrations.

- [x] Database worker: test-first private normalized tables/functions and embedded >2MB/405-candidate restart/immutability/permissions cases.
- [x] Runtime worker: test-first runPagedShadowInvocation with compact state, bounded page/batch operations, exact HTTP hashing, existing reserve/dispatch/settlement and remaining-time guards.
- [x] Parent: actual SQL + fabricated HTTP integration covering all candidates, final page, empty scan, interruptions, budget/cost and uncertainty.
- [ ] Independent review and real PostgreSQL concurrent append/batch/accounting CI.
- [ ] Audit all #161 acceptance, implement remaining authenticated producer/configuration/observability contracts, document external approval/evidence gates truthfully.
- [ ] Full local checks, exact-head CI, merge only after required implementation/review evidence is present; never claim issue completion from mocks or deployed readiness from local tests.

## Delivered continuation contracts

- [x] Exact-byte adaptive preview before batch freezing; oversized singletons defer without skipping.
- [x] Proven-no-attempt budget deferral and immutable model/configuration/usage/cost audit.
- [x] Dedicated-token handler, inactive Deno entrypoint, platform JWT setting and fixed PostgREST service.
- [x] Disabled administrator-owned selector with UTC-hour idempotency and continuation/uncertainty holds.
- [x] Independent whole-slice review: no outstanding findings in disabled scope.

Local evidence: 247 JavaScript tests, full embedded SQL suites, and Deno2.5.6
entrypoint type check pass. Real PostgreSQL audited-batch/selector contention and
actual PostgREST handler/runtime coverage are configured in CI.

Issue #161 remains open for authorized hosted/model evidence and its full
acceptance scope. See docs/warpcore-agent-producer.md for the concrete activation
boundary and remaining dependencies. No schedule, database or model is enabled.
