# Agent news source expansion implementation plan

**Goal:** Add approved public discovery sources with high-level selection.
**Spec:** ../specs/2026-11-18-agent-news-sources-design.md
**Architecture:** Existing RSS/HTML adapters, checkpoint persistence, strict
verification provenance and guarded publication. No new service or subscription.
**Execution:** Native in the current isolated worktree; scope approved by owner.

## Tasks
- [x] Add feed roster/allowlists, dated DeepSeek and space HTML extraction,
  and a one-page resumable HF Posts adapter. Test malformed layouts, pagination,
  bounded retrieval, source identity and unchanged existing sources.
- [x] Extend worker provenance and SQL verification-host configuration for approved announcement and reporting
  publishers; keep arbitrary GitHub/HF user namespaces rejected. Test parity.
- [x] Add explicit high-level agent/JetBrains policy guidance and regression
  cases. Document exact sources and observed endpoint limitations.
- [x] Run collector/agent/shared tests, embedded SQL checks and public adapter
  smoke tests; review diff and report code versus deployment status separately.

## Review focus
DeepSeek changelog identity across dates; Pi announcement identity; HF offset
pagination limitations and restart head; HTML layout failures; worker/SQL receipt
parity; resource capacity as roster grows; no credentials or mailbox signup.

## Validation and review
582 unit/mock tests passed; all 52 embedded SQL integration programs passed;
10 timer tests passed. Public production-compatible parsing succeeded for nine
new endpoints; xAI returned 403 and is deferred outside the active roster.
Independent review found a policy-cutover locking race, now fixed and re-reviewed.
No live multi-session concurrency or production collection was claimed.
Deno 2.5.6 checks passed for collector, agent and discovery-stage entrypoints
with the repository import map and automatic dependency installation.
