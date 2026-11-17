# Ranking acceptance checkpoint

The full-scan ranking implementation was tested on November 16, 2026 (Eastern).
This checkpoint is not production deployment or editorial quality acceptance.

- Node 22 JavaScript tests: 144 passed, including the agent and Halo tool suites.
- Full embedded SQL integration suite passed, including ranking and scheduler.
- The ranked fixture assessed 405 candidates, retained the strongest candidate
  on the final page, and returned the same ordered shortlist with batch sizes
  37 and 100. Empty/all-skip, late canonical exclusions, invalid scores,
  restart fencing, and lease-loss rollback were exercised.
- Strix Halo ran PostgreSQL 17.6, PostgREST 12.2.3 and Node 22.23.3.
  `shadow-producer-postgrest.mjs` and `shadow-agent-concurrency.mjs` passed after
  the existing publication/curator fixture prerequisites. These tests used
  fabricated model responses, with no paid calls or publication writes.
- The real contention test covers empty ranked finalization. The PostgREST
  selection test covers service access, denied anonymous/authenticated roles,
  and a historical unranked null response. The populated ranked shortlist is
  covered by embedded SQL, not yet by an end-to-end paid ranked run.
- The scheduler test uses an explicit embedded extension-catalog shim;
  production pg_cron/pg_net compatibility remains a deployment check.
- Owned Halo containers, volumes, network and scratch were removed and the
  machine reservation was released; the final lock status was FREE.

Independent review found no concrete defect in the ranking SQL. Its direct
private-finalizer denial assertion alone does not establish repeat-finalization
immutability; the public paged entry point's stale-revision race is the stronger
evidence. The shortlist remains a private verification proposal, not approval.
