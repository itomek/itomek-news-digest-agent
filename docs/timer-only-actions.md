# Supabase processing, GitHub timer only

Prepared, inactive, not authorized to create credentials or start hourly runs.
All news collection, editorial review and publication remain in Supabase. This
workflow only makes two authenticated fixed-endpoint HTTPS POSTs. The Bluesky app
password and Supabase server key NEVER go to GitHub. No news is collected by Actions.

Public standard GitHub-hosted runners are free under current official pricing:
https://docs.github.com/en/actions/concepts/billing-and-usage
No private-repository compute quota is charged for this public repository's standard
runner. No paid runner, third-party timer account or self-hosted machine is needed.
Scheduled jobs can be delayed/dropped under load; public schedules disable after
60 days with no repository activity. This is not an exact-time SLA:
https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule

## Off by default

Only workflow_dispatch exists, with no parameters and no schedule. The job also
requires the default main branch and `WARPCORE_TIMER_ENABLED=true` repository
variable, which has NOT been set. No GitHub secrets were created. Missing config
fails before any request. Production function locks still apply independently.

After explicit authorization, store only narrow trigger credentials in repository
Actions Secrets: `WARPCORE_GATEWAY_ANON_JWT` (existing public anon JWT),
`WARPCORE_COLLECT_TOKEN` and `WARPCORE_PUBLISH_TOKEN` (different random values,
at least 32 characters). The latter two must match Supabase Edge secrets
`WARPCORE_CRON_TOKEN` and `WARPCORE_PUBLISH_CRON_TOKEN`. Never use a service-role
key. No credential should be pasted into chat, workflow source, logs or artifacts.

Only after content scope, account, curation, hourly guard PR #139, and live
connection checks are complete: review adding `schedule: [{cron: '17 * * * *'}]`
and enable the variable. The old Supabase cron jobs must stay inactive so there
is a single scheduler. Publishing processes already-approved records, not raw
collector output. Scheduler responses don't prove a new story was published.

Requests have a 60-second timeout, no redirects, no retries, and no body logging.
Failure stops the run; publisher 429 means the UTC-hour reservation was already
consumed. No workflow retry loops. The publisher reconciles uncertain writes.

## Supabase pg_net alternative investigated and restored

Owner approved trying internal-only pg_net. Hosted migration
`20261112153421_warpcore_network_scheduler` installed it, but verified grants
remained PUBLIC because objects are owned by supabase_admin, not postgres.
No secrets or HTTP requests were queued. The supported drop was approved and
migration `20261112154513_warpcore_network_restore` restored absence of both the
extension and net schema. Both Warpcore schedules remained inactive; TTS and
existing schedules unchanged. Those two hosted historical migration versions
must be reconciled via db pull before future CLI database deployments; do not
replay the failed privilege attempt.

Official explanation confirms that per-project changes to those managed grants
are unsupported, including via Dashboard, and recommends restricting access paths
or removing the unused extension:
https://supabase.com/kb/troubleshooting/revoking-access-to-pg_net-objects-has-no-effect-0bbc16

A timer-only external trigger avoids storing trigger credentials in pg_net's
broadly DB-readable request queue. This document does not authorize activation.

Security review: checkout is pinned to verified official commit
`11d5960a326750d5838078e36cf38b85af677262`. Repository/workflow write access is part
of the trigger-secret trust boundary. A timeout is uncertain invocation, not proof
of non-execution. The initial scaffold deliberately stops if collection fails;
independent publishing/reconciliation during collector outages can be reviewed
before activation, without treating raw collection as publication approval.
