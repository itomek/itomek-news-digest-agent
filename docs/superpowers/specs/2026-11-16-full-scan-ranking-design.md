# Full-scan ranking and inactive continuation

Issue #161 remains the scope contract. The owner asked to continue the identified
ranking, final-selection and scheduler gaps, using agents, without more model-specific
work. This design records implementation choices within that authorized scope;
the new overarching owner goal authorizes deployment and real Bluesky posting after
validation, using Strix Halo for testing and creating no additional paid services.
This slice keeps production disabled until the downstream verification and guarded
handoff are complete; these are release gates, not a request for repeated permission.

## Approach

Use the existing Deno/PostgREST/PostgreSQL state machine. A new versioned discovery
response includes absolute policy-anchored `importance` and `relevance` integers
0..4. Persist every assessment with its candidate; never retain only page winners.
After the terminal scan and complete review coverage, PostgreSQL orders the entire
eligible result by importance DESC, relevance DESC, candidate ID ASC and atomically
persists zero to five verification proposals before marking the run complete.

A separate model-ranking pass would add calls, accounting phases and repeated
input without being required for global ordering. Per-batch top-five pruning or
choosing the first verify rows would violate the issue. Absolute rubric scores
plus a whole-run sort is the chosen implementation; it is not an editorial-quality
claim or proof that model scores are perfectly calibrated.

## Contracts

- Rubric `2026-11-16.1`: importance 0 skip, 1 modest meaningful development,
  2 material improvement, 3 important new capability, 4 exceptional major change;
  relevance 0 skip/outside scope, 1 meaningful but indirect permitted interest,
  2 clear stated interest, 3 direct work relevance, 4 strong direct priority.
  Scores are absolute, not relative to the current batch. `skip` requires 0/0;
  `verify` requires both scores 1..4. The existing editorial policy decides scope.
- Ranked decisions contain exactly `id,action,reason,importance,relevance`.
  Profile `2026-11-16.3` uses `discovery-ranked-json-schema-v2` and binds
  `rankingRubricVersion:2026-11-16.1`, retaining Groq/ZDR/low reasoning/prices.
  Existing v1 contracts and stored profile versions remain available unchanged.
  Fresh runs use the new profile; old billed runs are never retrofitted.
- `shadow_agent.ranking_runs`: one immutable rubric/algorithm binding per ranked
  run, assessed count advanced atomically with each committed batch, and final
  eligible/selected counts, revision and timestamp.
- `shadow_agent.selection_items`: at most five ordered proposals per run, linked
  to frozen candidates/scores. `requires_verification` is the only new authority;
  facts-verified and publication-approved flags remain false.
- `shadow_agent.ranking_finalize(run,lease,revision)` is called only from the
  empty terminal review path for ranked runs. Require exact complete candidate,
  decision and assessed counts; recheck canonical story status and current inbox/
  publication exclusions; sort ALL remaining verify assessments. Final metadata,
  shortlist and completion checkpoint commit under the same run lease/CAS lock.
  A lost response is recovered by loading the complete checkpoint; no second
  selection or inference is authorized. Legacy unranked runs retain old behavior.
- `shadow_agent.selection_summary(run)` and a service-role-only
  `public.warpcore_shadow_selection(run)` return bounded durable ranking metadata
  and at most five proposals. Before finalization they expose no proposals.
- New ranking SQL is installed after audit SQL and before producer SQL. Binding
  ranked profiles fails before inference if the ranking contract is absent.

## Boundaries

The producer writes no canonical story status, curator inbox, publication or
publisher row. The five proposals are not queued editorial submissions. Combined
live pending/admission protection against legacy writers belongs to #163's shared
handoff guard; this slice must not claim to prove it or modify that working path.
Verification, semantic event dedup, native identity and guarded submission remain
#162–#164. All captured candidates are still reviewed even if final live exclusions
remove them from the shortlist. Missing canonical schema fails closed.

## Scheduler

Add a separate `install-agent-disabled.sql`, preserving existing jobs. Require
reviewed pg_cron/pg_net/Vault and installed shadow contracts, refuse duplicate job
names, and atomically create a one-minute continuation job inactive. The command
calls a private enqueue helper with no caller configuration. Protected scheduler
settings pin an approved canonical Supabase project origin; Vault's runtime origin
must match it exactly. Resolve distinct gateway JWT/producer tokens at execution,
validate them, send only `{}` with the two required authentication headers, and
use a bounded HTTP timeout. Workers cannot read Vault, enable jobs/settings or
provision budgets. No extension or standing budget is created.

The entrypoint uses an explicit server-owned `WARPCORE_AGENT_ENABLED=true` flag
with a false default. Cron, database producer settings and this flag remain off.
No installation or activation against any live project is authorized here.

## Verification

Use synthetic model responses for the main acceptance campaign: 405 same-source
candidates with more than five promising early rows and the strongest on the last
page; no shortlist before full review; stable ties and batch partitioning; restart,
lease/CAS loss, concurrent finalization, empty/all-skip scans, invalid scores,
late exclusions, unchanged costs/uncertainty and private grants. Execute scheduler
payloads against disposable cron/net/Vault fixtures, including missing/duplicate
credentials, origin mismatch and disabled producer. Existing full SQL/HTTP and
concurrency gates remain required. Only a small ranked-schema real-model check
may use the existing remaining campaign approval, after exact preflight/reservation.
