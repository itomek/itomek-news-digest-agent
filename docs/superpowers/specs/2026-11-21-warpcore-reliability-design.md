# Warp Core operational reliability — issue #165

Status: concise scope approved by owner in chat on November 21; implementation independently reviewed. No hosted changes applied.

## Intent and boundaries

Production cutover has happened according to issue #165. Reduce repeated alerts while preserving new incidents, persistence reminders, explicit recovery and renewed outages. Classify processing from source freshness and stage progress rather than elapsed time without posts. Retain one editorial producer and all queue, evidence, financial and uncertain-outcome records.

No deployment, Gmail automation, credential, subscription, policy or posting changes are authorized. Existing fixed-recipient notification transport remains optional and cannot block processing. Owner feedback remains pinned to the existing public DID, immutable URI deduplication and inert review scope; it grants no policy, credential or reply authority.

## Approaches

1. In-memory or report-text deduplication is small but cannot survive fresh function instances, distinguish new failed items, or establish recovery. It does not meet the issue.
2. Extend aggregate dashboard alert state. This reuses durable transitions but its code-only identity loses distinct entities and has no delivery acknowledgment or reminder lifecycle.
3. Recommended: a private per-entity incident ledger with narrow RPCs, integrated into the existing notifier, alongside better persisted health observations. This adds database contracts but supports concurrency, recovery and delivery uncertainty explicitly.

The recommendation is a builder proposal, not an owner-approved decision.

## Incident lifecycle

Use stable domain/entity/sanitized-class keys: configured source identity and generation, or durable item/job identity and relevant evidence revision. Store active generation, first/last observation, confirmed notification time, reminder eligibility, recovery observation and fenced notification claim. Persist only bounded identifiers and safe enums, never provider bodies or credentials.

Atomically claim new incidents, due reminders and explicit recoveries. Acknowledge confirmed SMTP acceptance only. Failed delivery must not block queue processing. Timeout remains uncertain delivery and must not cause immediate blind replay; exactly-once SMTP delivery cannot be claimed. Resolve only from authoritative successful observations for the same entity/configuration, never absence from an invocation, a busy worker or a narrowed source selection. A later failure after recovery opens a new generation.

Reminder and uncertainty retry intervals must be explicit configuration with documented defaults chosen during implementation. New entities/classes signal immediately even while an older incident stays active.

Include origin/main commit 83621c8 (history contention retry, #194): a recovered history read remains silent; exhausted history contention, source transport/freshness problems, and item draft rejection retain distinct safe classifications. Draft rejection cannot imply publisher outage or bypass publication checks.

## Health observations and classification

Persist collector head-check time, typed coverage reasons and accepted acquisition/progress independently from exhaustive historical success. Preserve finite feed history limitations versus malformed dates and genuine failures. Scope health to the trusted configured roster, not every historical checkpoint row.

Expose stage backlog counts, oldest work and semantic progress for discovery, verification, handoff and publication. Keep existing response fields compatible. Add safe operational reasons for healthy quiet, coverage limitation, progressing, degraded and stalled states. An advancing partial scan can coexist with stale source-head attention; neither signal erases the other.

Fresh inputs and completed review with no eligible items are healthy quiet. Finite historical gaps are coverage limitations. Advancing archive/review/verification work is progress. Pending eligible work past its progress threshold is a stall; missed source attempts and transport errors are separate degradation signals. Lease churn alone is not progress. Zero posts alone never establishes failure. Published state and remote URI are receipts; unknown publication confirmation time remains unknown.

## Documentation and rollback

Reconcile README, architecture and producer documents to the active pipeline. Distinguish dated hosted evidence (43 sources) from tracked configuration (55 sources); do not assert current live counts or deployed hashes from repository contents. Document a reproducible read-only inventory of deployed artifact versions, schedule/trigger dispatch, source roster and cost/model policy, with unknown fields explicitly identified.

Replace future-cutover instructions with current disable and recovery guidance. Identify producer, submission and dispatch controls and in-flight boundaries. Stopping new decisions must retain collection queues, run/evidence records, reservations, settlement audits, publication guards and uncertain records. Recovery reconciles exact remote records/collections before retrying; no blind send retry, audit deletion or second producer. Documentation must account for later drain-without-hourly-quota migrations rather than retaining obsolete hourly attempt limits.

## Verification

- Fresh notifier instances deduplicate the same entity incident; different sources/items/classes alert independently.
- Concurrent claims, reminder deadlines, one recovery, renewed outages, lease expiry and idempotent acknowledgments.
- Missing observations, narrowed roster, disabled/unconfigured delivery, failures and timeouts never fabricate recovery or confirmed delivery.
- Finite gaps versus malformed dates; advancing partial scans versus stale heads; semantic progress versus lease churn; verification backlog stalls; quiet cycles and publication timestamp honesty.
- Private table/RLS/RPC privileges, bounded safe metadata and optional notification queue independence.
- Run relevant Node unit tests and disposable SQL integration tests, with no production writes or real notifications. Review docs against tracked source/migrations and label live verification as outstanding where unavailable.

## Subsequent rollout authorization

After implementation review, the owner explicitly authorized merging and deploying once ready. This supersedes the original local-only deployment boundary for this change. Rollout must preserve live source configuration, authentication, credentials, financial/uncertain records and the single producer; inventory and verify the exact installed artifacts before updating them.
