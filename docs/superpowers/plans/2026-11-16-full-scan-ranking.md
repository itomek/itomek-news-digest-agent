# Full-scan ranking implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Complete #161's durable global-ranking/final-selection and inactive scheduler wiring.
**Architecture:** Persist rubric scores in bounded review batches; finalize one global SQL ordering only after complete coverage. Install a distinct continuation schedule inactive and retain every publication boundary.
**Tech Stack:** Existing JavaScript/Deno, PostgreSQL/PostgREST, pg_cron/pg_net/Vault; no new runtime dependencies.
**Spec:** `docs/superpowers/specs/2026-11-16-full-scan-ranking-design.md`.

## Global constraints

- During this slice, production, database selector and schedules remain disabled; preserve the working pipeline and CyberAI. The broader goal authorizes eventual validated deployment and real posting without additional paid services.
- No model tools, alternate inference gateway, public writes or automatic uncertain retry.
- Preserve old schema/profile versions and billed history; use fresh ranked runs.
- Retain the current $2/24-call pilot ledger for development checks (14 used); the broader owner goal permits OpenRouter use for the final service, with explicit conservative production limits set before activation.
- Review every eligible candidate, then globally order; shortlist zero to five for verification only.

## Review focus

- A high-priority candidate after the first 300 must outrank earlier candidates.
- Scores and shortlist must survive restart without rescoring committed work.
- New inbox/publication exclusions must apply at finalization without mutating history.
- Concurrency/lease failure must not leave partial rankings or duplicate selections.
- Disabled or misconfigured scheduling must queue no HTTP and expose no secrets.

### Task 1: Versioned ranked discovery contract

**Files:** create `news-agent/ranking-rubric.mjs` and tests; modify `review-contract`, `model-profiles`, `evaluation`, `openrouter` and their tests under `supabase/functions/news-agent/`.
**Interfaces:** `RANKING_RUBRIC_VERSION`, rubric instructions; canonical `DISCOVERY_RANKED_RESPONSE_FORMAT`; profile `2026-11-16.3`/`discovery-ranked-json-schema-v2` with `rankingRubricVersion`. Ranked decisions have five exact fields. Preserve `requestProfileForModel(model, version?)` for old versions; default GPT-oss becomes ranked.

- [ ] Write/run failing tests for ranked schema, absolute rubric, out-of-range/noninteger/skip-nonzero scores, omitted coverage, old-contract compatibility and frozen profiles.
- [ ] Implement shared contract/rubric and versioned builder/transport validation without weakening usage/provider accounting.
- [ ] Run focused JavaScript tests and independent review; checkpoint the diff.

### Task 2: Durable global SQL ranking

**Files:** create `supabase/functions/news-agent/sql/shadow-ranking.sql`; modify `shadow-paged.sql`, `shadow-audit.sql`, `shadow-producer.sql`; adapt runtime/services only where needed. Add `integration-tests/shadow-ranking.mjs` and focused integration coverage; coordinate package-script update with Task 3.
**Interfaces:** `ranking_runs`, `selection_items`, `ranking_finalize(uuid,uuid,bigint)`, `selection_summary(uuid)`, `public.warpcore_shadow_selection(uuid)`. Task 1 supplies schema/profile/rubric. Existing 12-field paged checkpoint can remain compact; scored metadata is normalized.

- [ ] Write/run failing embedded SQL tests: 405 candidates, strongest last page, >5 early verify rows, no early shortlist, all-skip/empty, ties/batch invariance, missing/invalid scores, restart/lease rollback and final exclusions.
- [ ] Implement true-only versioned binding, atomic assessed counters and terminal whole-run ordering; require installed ranking contract before paid ranked binding.
- [ ] Prove private grants, immutable completion and no canonical/inbox/publication writes. Add real PostgreSQL contention and PostgREST RPC coverage using disposable fixtures.
- [ ] Run SQL/runtime suites and independent review; checkpoint the diff.

### Task 3: Inactive scheduler and environment gate

**Files:** create `supabase/schedules/install-agent-disabled.sql`, `integration-tests/shadow-schedule.mjs`, entrypoint tests; modify `news-agent/index.ts`, `integration-tests/package.json`, and `docs/warpcore-agent-producer.md`.
**Interfaces:** a private enqueue helper and protected approved-origin settings; distinct job `warpcore-news-agent-continuation`; Vault names `warpcore_agent_project_url`, `warpcore_agent_gateway_anon_jwt`, `warpcore_agent_cron_token`. Explicit environment enable flag defaults false. Scheduler never controls model/run/budget via request.

- [ ] Write/run failing tests proving installation queues nothing, preserves unrelated jobs, duplicate refusal, disabled no-op, exact authenticated `{}` payload, and refusal for missing/duplicate/short secrets or wrong origin.
- [ ] Implement inactive installation transaction and bounded private enqueue helper; prove worker roles cannot modify/read administrative resources.
- [ ] Test handler enable/auth/body controls with environment absent/false/true; retain platform JWT configuration.
- [ ] Add ranked/schedule test scripts to the full embedded suite, update operational instructions and independent review.

### Task 4: Integration and delivery

**Owner:** parent. Update Halo/pilot fixture loaders and ranked mocks; keep historical receipts unchanged.

- [ ] Run 405-candidate scored runtime/SQL integration, real concurrency/PostgREST tests, full JavaScript, Deno and timer suites.
- [ ] Independently review the full diff and acceptance mapping; fix defects rather than weakening assertions.
- [ ] If needed, preflight/reserve one small ranked-schema call under the existing campaign; no unattended paid activation.
- [ ] Record exact-source evidence, update PR #169 and wait for current-head CI. Continue #162–#165 under the overall deployment/posting goal; do not activate an incomplete pipeline or prematurely close downstream issues.

## Execution decisions

User requested continued implementation with agents after the specific missing scope
was identified. This plan uses that existing authorization and execution method;
there is no new platform, spending scope or deployment decision requiring a pause.
The score-based implementation and per-run private shortlist are builder decisions,
not a claim that the owner approved new editorial thresholds or queue admission.
