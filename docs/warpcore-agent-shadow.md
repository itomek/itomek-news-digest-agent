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
