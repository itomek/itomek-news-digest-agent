# Autonomous curator: offline shadow foundation

Related work: [#159](https://github.com/itomek/itomek-news-digest-agent/issues/159),
[#160](https://github.com/itomek/itomek-news-digest-agent/issues/160) and
[#164](https://github.com/itomek/itomek-news-digest-agent/issues/164).

## Goal and boundary

Move editorial production into an independently scheduled Supabase agent with
OpenRouter-only model calls. Reuse collection, validated inbox/outbox processing
and publishing. `news-curate` is the existing decision drain, not an AI editor.
The foundation is **offline and nonpublishing**: it is not a replacement for the
current dot curator and does not establish that a model selects good stories.
No production activation, schedule, source, credential, budget or publication
change follows from committing or testing these files.

`supabase/functions/news-agent/policy.mjs` exports a deep-frozen, versioned
`EDITORIAL_POLICY` and `buildEditorialInstructions()`. It records November 14
editorial requirements as guidance for a future model, not keyword matching or
an automatic allowlist. Version changes must be explicit and reviewed. Feed
content and owner replies cannot modify policy. Keep the existing source,
full-review and native-repost documentation as operational references.

## What tests can and cannot prove

This slice tests request completeness (including 405 same-source inputs), hidden
gold labels, decision schema, coverage and selection mismatch reporting. It does
not yet test database scans, source verification, post formatting or native
identity. Recorded public stories supply discovery-review expectations without
spending tokens or posting. `verify` means investigate, not publish; fixtures
are not frozen verified evidence and cannot be submitted to the live pipeline.
Tests against stubbed decisions **do not prove model judgment**, factual truth,
live source availability, OpenRouter compatibility, hosted execution or Bluesky
rendering. Synthetic adversarial inputs must be identified as synthetic rather
than presented as real source evidence.

Before adoption, run the actual proposed model/framework against versioned,
independently labeled public-story fixtures and then fresh live feeds in shadow
mode. Compare selection, omissions, factual support, duplicate events, concrete
useful details and attribution. Inspect the complete rendered post and every
captured source link. Include important frontier AI/chip/inference announcements,
routine patches, stale stories, political exclusions, local/F1 boundaries, vendor
claims and exact native repost originals. Include the owner’s November 14 correction: granular PyTorch/Helion kernel optimizations are not relevant merely because they improve GPU defaults; a verified material connection to the inference tools or hardware he uses is needed. A model cannot verify its own output by
asserting that it did so. Record retrieval evidence and human-review disagreements.

## Remaining implementation and adoption gates

1. Select and prove a small TypeScript/Deno-compatible framework and OpenRouter
   adapter. Evaluate structured-output/tool-call reliability, cancellation and
   Edge Function compatibility. No direct-provider fallback. Do not infer that
   current plain `.mjs` files prove a framework or hosted agent works.
2. Agree explicit model allowlist and per-run/day spend bounds before paid calls;
   add a usage ledger, token/request bounds and circuit breaker. No keys are
   required for this offline foundation.
3. Add durable fixed-timestamp, keyset-paginated review state, leases and resume.
   Review every eligible candidate before selection. Timeouts must not become
   source quotas or arbitrary review ceilings. Validate real PostgreSQL overlap,
   restart and uncertainty behavior, not only an in-memory simulation.
4. Add safe public retrieval and evidence verification, whole-window semantic
   dedup and the frozen snapshot/guarded submission boundary. Give the producer a
   truthful agent identity; do not reuse the dot's actor identity.
5. Reconcile deployed bundles/schema/configuration with tracked source before any
   deployment. Existing entrypoint activation flags and deployment documentation
   may differ. Never blindly redeploy an old or disabled worker bundle.
6. Prove live shadow outputs against the editorial rubric, with zero writes to
   production publishing. Agree quality thresholds and review representative
   outputs with the owner. Then use an explicitly authorized isolated test account
   to verify real Bluesky rendering and native-author attribution. No synthetic
   test spam on the production account.
7. Stage production cutover with one active editorial producer, exception-only
   operational alerts, cost/source/review-coverage observability and rollback.
   Do not stop the dot schedule before independent operation is proven. Retain
   uncertain records and a collection-aware publisher during rollback.

This work does not claim issues #159–165 are complete. Source expansion, audio,
a new reader UI and unrestricted owner-feedback action execution remain outside
this foundation.

## Running the offline evaluator

Run unit contracts with `node --test supabase/functions/news-agent/*.test.mjs`.
The actual candidate inputs are in `real-story-cases.json`; seven come from a
recorded configured feed scan, and the eighth is the owner's explicit Helion
negative example, checked against its public post. All other labels are provisional
editorial expectations, not owner-approved gold labels. Review and expand these
labels independently before measuring model quality.

`buildReviewRequest(cases, {model, allowedModels, maxOutputTokens})` produces an
OpenRouter-compatible JSON request body only. It performs no network operation.
Model/provider compatibility and live costs remain untested. Neither expected
actions nor editorial rationales are sent to the model.

To score saved output shaped as `{"decisions":[{"id":"...","action":"skip",
"reason":"..."}]}`, run:

```sh
node supabase/functions/news-agent/evaluate-cli.mjs \
  supabase/functions/news-agent/real-story-cases.json saved-response.json
```

Exit 0 means all supplied labels match, 1 means missing/mismatched decisions,
and 2 means invalid inputs. Even a perfect score explicitly reports
`modelQualityProven: false`; a mocked response is only a contract test.

## Resumable core (second slice)

`newShadowRun` fixes the scan time and policy version. `advanceShadowRun` scans
keyset pages to an empty terminal page before model review. Each invocation handles
a bounded number of pages or one review batch; invocation bounds are not total
review limits. All decisions remain `skip` or `verify`, not publication approvals.

The injected `save(next, expectedRevision)` **must** implement durable atomic
compare-and-swap and lease checks. Workflow unit tests use an in-memory store; the separate SQL contract below adds
an isolated durable-store candidate. There is no scheduled entrypoint yet. Review state is persisted as
`reviewing` before invoking the model. After a crash or uncertain model response,
the run requires reconciliation rather than repeating a possibly billed request.
Missing, duplicate or unknown decisions cannot finish a batch. Completion means
all discovery candidates were considered, not selected sources verified or final
stories ranked. Global semantic deduplication and ranking still need implementation.

Before any live wiring, persist request/spend reservations in the same trusted
workflow and implement concurrency tests against actual PostgreSQL. Do not simply
supply an in-memory save adapter to a hosted function and call it durable.

`reviewWithOpenRouter(request, config, fetcher)` now provides a single-attempt
OpenRouter transport seam. It is disabled unless explicitly enabled and requires
an injected fetch function, key, allowed model and cost reservation. It uses a
fixed endpoint, disables redirects/fallback routing, bounds tokens/body/time and
requires complete structured decisions and usage/cost metadata. It does not look
up secrets. Errors after transmission are uncertain and never automatically retried.
The caller must durably reserve a verified worst-case cost under run/day limits
before dispatch, persist actual usage and reconcile uncertainty. A reservation
object alone is not a budget implementation. The offline composition test uses
synthetic usage, not a real request; live API compatibility remains unproven.

Provider `usage.cost` is treated as OpenRouter credits (`costCredits`), not an
assumed USD amount. The reservation is `maxCostCredits`; conversion to the owner's
approved currency budget must be explicitly verified before live activation.
Missing cost fails closed. `json_object` mode guarantees JSON only; local validation
enforces the decisions schema. Exact response-model equality is deliberately
conservative and may reject aliases; verify chosen canonical model IDs live.
References: [usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting),
[API reference](https://openrouter.ai/docs/api_reference/overview).


## Isolated persistence contract (third slice)

`supabase/functions/news-agent/sql/shadow-state.sql` is proposed **shadow-only**
PostgreSQL infrastructure, deliberately outside `supabase/migrations`. Normal
migration deployment will not install it. Do not manually apply it to production
as part of this draft. There is no live database connection, model dispatch,
secret lookup, publication API or hosted scheduler in this slice.

The private schema keeps run checkpoints and budget accounting separate from the
existing curator/publication tables. Trusted administrative setup provisions
limits; workers cannot raise limits or directly edit accounting tables. Leases
and revision checks fence checkpoint writes. One attempt is bound to each reviewing checkpoint, even when a retry changes
the request hash. Reservations must precede dispatch;
uncertain attempts retain their reserved amount until explicitly reconciled.
A reservation is not permission to make a paid request, and a request hash does
not prove that the dispatched HTTP request actually matches it. Runtime wiring,
canonical request hashing and approved worst-case pricing remain required.

Embedded SQL tests cover the contract; a separate disposable PostgreSQL CI test
exercises genuine independent-session contention. Neither is model evaluation.
The service bridge, real API/usage compatibility, owner-approved spending limits,
verification/ranking and hosted shadow run are still not implemented here.

The proposed checkpoint JSON currently has a 2 MB safety ceiling. Oversized
checkpoints raise an explicit error, never truncate candidates or declare a
partial scan complete. Normalized/paged candidate persistence is still required
before claiming this store supports arbitrarily large review backlogs. The
per-invocation page limits remain transport bounds, not editorial review quotas.

Dispatch also refuses a reservation from a previous UTC date; its hold is retained
for explicit reconciliation. Late results can settle against the original
reservation day using the original token, without permitting stale state writes
or another dispatch. This is conservative reservation-day accounting, not a
claim of matching a provider's eventual invoice timestamps.

A future runtime must separate cost settlement from editorial success. If the
transport reports trustworthy usage alongside malformed decisions or another
completion error, record the actual billed cost while leaving the workflow
uncertain. Do not discard known usage merely because the model output failed
validation. Unknown cost retains the full reservation; neither case permits an
automatic retry of the same reviewing checkpoint.

SQL enforces one attempt per checkpoint revision, not a complete workflow state
machine. A trusted caller must use the validated workflow transitions; manually
advancing a revision while replaying the same batch would defeat that semantic
protection. A production bridge must enforce transition/batch identity as well
as the existing revision fence before enabling autonomous dispatch.

## Disabled injected runtime (fourth slice)

`runtime.mjs` composes the existing workflow and private SQL contract with supplied
query, candidate-page and HTTP dependencies. It does not open a database connection,
read environment secrets or register an HTTP server/cron. It is off unless explicitly
enabled, and its caller must already have authorization for any model spending.
Tests supply disposable SQL and fabricated OpenRouter responses only.

This is a runtime integration seam, not a deployed or hosted agent. Live activation
still requires a vetted database adapter and source-page query, endpoint authentication,
worker scheduling/observability, approved model/pricing/budget settings, and a safe
reconciliation procedure. The model's `verify` decision is only a request for later
verification; this module cannot approve or publish stories.

The configured lease must exceed the transport timeout by at least five seconds.
That preflight check does not guarantee remaining lease time after slow SQL or
network operations. Lease loss fails checkpoint writes closed; any billed response
can still be settled with the original reservation token, but the run then needs
manual reconciliation. A hosted worker needs safe lease renewal or a remaining-time
guard before dispatch rather than relying on the initial margin alone.

## Source adapters (fifth slice)

`createCandidateSource({query})` supplies the runtime's `fetchPage` using the exact
operator-contract discovery filters: fixed collection cutoff, seven-day source
window, newest candidate per story, live inbox/publication exclusions and ascending
exclusive keyset cursor. Each SQL page contains at most 100 entries; callers keep
scanning until empty. There is no per-source or total review quota. Invalid rows
fail the page explicitly rather than silently producing an incomplete scan.

`fetchCapturedEvidence` is disabled by default. When explicitly enabled with a
trusted injected transport, it only retrieves an exact captured URL from identified
public, non-Bluesky evidence on an explicit hostname allowlist. It refuses redirects,
credentials, noncanonical URLs and unsupported MIME types, and bounds streamed
bytes/time. Returned HTML/text/JSON remains untrusted; the packet explicitly has
`factsVerified:false`. It neither extracts factual claims nor follows page links.
Bluesky's URI/CID/author verification requires a different native-record path.

Hostname validation is not DNS pinning. A production transport must enforce public
network/DNS/IP egress restrictions, including redirect behavior, before this seam
is wired to live retrieval. No such egress policy or hosted network adapter is
installed by this PR. Source availability, fetched bytes and matching a fixture
label do not prove a story's factual accuracy or significance.
