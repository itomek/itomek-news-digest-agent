# Warp Core Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Execute the independent tasks with scoped agents.

**Goal:** Implement issue #165 without production changes.
**Architecture:** Private durable incident state behind service-only RPCs; existing fixed-recipient notifier; persisted source observations and compatible stage health; accurate operational documentation.
**Tech Stack:** JavaScript, Deno, PostgreSQL, Node tests, disposable PGlite.
**Spec:** docs/superpowers/specs/2026-11-21-warpcore-reliability-design.md (concise scope approved in chat).

## Global Constraints

- No deployment, credential, Gmail automation, subscription, editorial policy or posting changes.
- Preserve one producer, queues, evidence, financial audits and uncertain outcomes.
- No-post periods alone never establish failure; absent observations never establish recovery.
- Fixed recipients and sanitized metadata; notification failures cannot block work.

## Review Focus

- Concurrent notification claims and uncertain delivery must not create immediate duplicates.
- Narrow source selections and idle workers must not resolve unobserved entities.
- Archive progress and current head freshness are independent observations.
- Historical source rows must not inflate configured-roster health.
- Quiet review and draft rejection must not imply publishing outage.

### Task 1: Durable notification lifecycle

Files: news-agent/gmail-alerts.mjs and new incident module/SQL/tests, news-agent hosted wiring/index, news-collect handler/index notification observations only.

- [x] Add failing unit and disposable SQL tests for cross-instance dedup, new entities/classes, reminders, explicit recovery, renewed outage, concurrency, failures/timeouts and private grants.
- [x] Implement bounded private incident records with atomic claims and fenced acknowledgments; service-only APIs. Retain configured fixed-recipient SMTP transport. Use explicit observation identities and safe classification.
- [x] Wire item/source observations without changing source processing. Use 24-hour reminders, 15-minute failed/uncertain delivery backoff, 1-minute claim leases unless evidence requires adjustment; document defaults.
- [x] Run unit/SQL lifecycle and existing notifier/handler tests; report exact commands and results.

### Task 2: Operational health

Files: news-collect/checkpoints.mjs and tests; source health SQL extension; news-agent/sql/operations.sql and agent-alerts.sql; integration-tests/source-sync.mjs, agent-operations.mjs, agent-alerts.mjs.

- [x] Add failing fixtures for persisted typed coverage/head checks, configured roster, progressing partial work, stale head, stage backlog stalls and quiet cycles.
- [x] Persist accepted source freshness/coverage/progress observations separately from complete historical coverage. Preserve existing fields and RPC compatibility.
- [x] Add compatible operational classification based on stage age/progress, source freshness and durable receipts. Do not fabricate publication times. Keep finite gaps informational.
- [x] Run collector and relevant disposable SQL tests. Coordinate shared notification observation fields with Task 1; do not edit notification handler sections.

### Task 3: Operational documentation

Files: README, architecture, producer, readiness, activation, production and cost docs; new rollback reference as needed.

- [x] Reconcile active versus historical claims, tracked 55 versus dated hosted 43 sources, removed hourly quotas, exact artifact inventory and current cost-policy evidence.
- [x] Document stop controls and in-flight boundaries, state-preserving rollback, collection-aware reconciliation and recovery. Preserve pinned public owner-feedback scope.
- [x] Verify claims against tracked source and migrations; distinguish live unknowns and unexercised production procedures.

### Integration and review

- [x] Review each agent diff for scope, correctness and compatibility.
- [x] Run complete relevant Node suites and disposable integration suite.
- [x] Independent whole-change review; fix actionable findings and repeat affected checks.
- [x] Report local changes and verification; no live deployment or issue closure.

Validation evidence: 607 Node tests, 481 web unit tests, 10 timer tests, Deno checks, disposable SQL integration and real PostgreSQL incident contention. Live rollout and production procedure exercise are outside this change.
