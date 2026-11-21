# Offline editorial campaign evidence

Run from the repository root:

```sh
node supabase/functions/news-agent/editorial-campaign-cli.mjs /path/to/campaign.json
node --test supabase/functions/news-agent/editorial-campaign.test.mjs
```

The CLI opens a descriptor nonblocking, rejects nonregular files, reads at most 10 MiB plus one overflow-detection byte, and closes the descriptor even on errors. Exit 0 means the **reported evidence gates** passed; exit 1 means valid evidence has unmet gates; exit 2 means malformed input. It never fetches references, invokes a model, publishes, deploys or changes policy. All reports retain `publishingEnabled: false` and `modelQualityProven: false`. Public readback and owner go/no-go remain separate requirements.

No formal corpus or hosted run evidence is supplied here. Test data is synthetic validator coverage, not independently labelled editorial evidence. Existing regression examples must not be promoted into formal labels.

## Manifest schema (version 1)

The top-level JSON object has `schemaVersion: 1`, `rubricVersion: "2026-11-21.1"` (the exact version of the human editorial rubric, echoed in reports), `frozenAt` (UTC ISO timestamp), `labelsDigest` (SHA256 hex), `cases`, `heldout`, `cycles`, and `emptyChecks`.

Each case has unique `id`, distinct public HTTPS `sourceUrl`, valid UTC `sourceCreatedAt` no later than `frozenAt`, nonempty `discoveryText`, `expectedAction` (`verify` or `skip`), nonempty human `rationale`, and `review: {reviewer, authority, independent, reviewedAt}`. Reviewer and authority are nonempty strings; independent is a boolean. At least 20 independently reviewed public-story cases are required. Humans must establish that these are distinct stories, publicly accessible, independently labelled, and withheld from tuning and smoke tests, excluding known regression cases. Public URLs reject localhost/local-domain hosts and obvious private/reserved IP literals using the existing pure address classifier, without DNS/network access. URL deduplication normalizes host case/default port and removes fragments; original URLs remain in the frozen digest. URL uniqueness cannot establish independent stories or public accessibility. Historical boundary cases may be older than seven days; no freshness cutoff is imposed on this offline corpus. Source creation must precede or equal human review, which must precede or equal freeze; freeze must precede every saved invocation.

Compute `canonicalLabelsDigest(cases)` exported by `editorial-campaign.mjs` after human review and before invocation. It hashes UTF-8 JSON for the full case array sorted lexically by ID, recursively sorting all object keys while preserving nested array order. This binds discovery text, source URL/date, labels, rationale and review provenance, including any additional case fields. The digest detects label changes against the reported frozen value. Neither a hash nor metadata proves independence or an externally witnessed freeze: these are self-attested human review records. Retain an independently archived original manifest for audit.

Build any later inference request with existing `buildReviewRequest` from `evaluation.mjs`; its explicit candidate projection excludes expected actions, rationales and review metadata. Do not send the manifest or labels to the model. This offline CLI does not invoke inference or prove what an external runner actually submitted.

A completed saved inference run (`heldout` and each nonempty scheduled cycle) requires:

```json
{
  "id": "unique-run-id",
  "status": "complete",
  "invokedAt": "2026-11-21T01:00:00Z",
  "completedAt": "2026-11-21T02:00:00Z",
  "model": "google/gemma-4-26b-a4b-it",
  "provider": "PrimeIntellect",
  "policyVersion": "2026-11-19.1",
  "requestProfile": "REPLACE with full existing requestProfileForModel(model, '2026-11-17.8') object",
  "costCredits": 0.01,
  "evidenceRef": "saved/actual-run.json"
}
```

This schema illustration is not runnable evidence. `requestProfile` must be the exact existing object, including provider route, price bounds, reasoning, response format and ranking rubric. `costCredits` records the actual OpenRouter `usage.cost` credits, with no assumed USD conversion. Completed inference requires a finite nonnegative value; failed/deferred attempts may explicitly record `null` when cost is unknown. Reports identify the unit as `OpenRouter credits`; the offline validator treats this and route metadata as self-attested. Keep actual upstream response/provider and request in the evidence reference. Wrong route or policy is malformed input. Pending runs use only `{id, status: "pending"}` and cannot pass. `failed` and `deferred` runs require the same saved metadata as completed attempts and fail completion gates. Timestamps must be valid UTC ISO strings with seconds, optionally milliseconds, and ordered freeze < invocation <= completion.

`heldout.decisions` is the saved decision array accepted by `evaluateDecisions` (id, action, reason; optionally both ranking scores). Precision and recall each need >= 0.90 and nonzero denominators. Every case must have a decision. Missing positive decisions count as false negatives. Empty decisions never earn perfect accuracy.

Nonempty cycles additionally require `scheduled: true`, `environment: "cloud"`, `scheduledSlot` (UTC top-of-hour `producer_slots.utc_hour` identity, unique across cycles and no later than invocation), `captureRef`, `capturedCandidateIds` (unique captured IDs), `candidates`, `outputsComplete` (boolean human attestation that all rendered outputs are inventoried), and `outputs`. Controlled empty checks share the capture/candidate/output inventory fields, but use the distinct zero-call schema below.

Each candidate has `{id, status, evidenceRef, retrieval}`. `evidenceRef` identifies saved decision/status evidence. Completed discovery candidates also record `action` (`skip` or `verify`) and nonempty `reason`. Retrieval is explicitly `{status: "not_attempted", reason}` for skips/no retrieval, or `{status: "attempted", evidenceRef}` for actual attempts. Never invent retrieval evidence for discovery skips. Status is `complete`, `deferred`, or `failed`; every captured candidate must be represented, including retrieval failures and deferred work. Candidate IDs must be unique within each run; repeated feed candidates across different runs are legitimate. Unknown inventory members and duplicate IDs are malformed; omitted captured candidates are unmet coverage. References are nonempty saved artifact locations; the validator does not inspect their contents or establish their authenticity.

Heldout runs also require `outputsComplete` and `outputs`, with the same human review requirements. Each output has globally unique `id`, `candidateId` referencing a captured candidate (or a heldout case), `kind` (`draft` or `native-subject`), `contentRef` pointing to the complete rendered draft or native subject, and a separate human `review`:

```json
{"reviewer":"human-id","authority":"editor","reviewedAt":"2026-11-21T03:00:00Z","completeRenderedText":true,"unsupported":0,"duplicate":0,"misattributed":0}
```

Observed cycle outputs must link to a saved `verify` discovery candidate and either attempted retrieval evidence or an explicit candidate `sourceEvidenceRef` for captured/reused source evidence. Heldout outputs must link to an actual saved `verify` decision and include output `sourceEvidenceRef`. Contradictory skip outputs and outputs lacking source evidence remain visible in reports and fail the output-review gate. Review time must follow run completion. Counts are nonnegative integers from human review of complete text against retrieval evidence and prior outputs/history. Any positive count fails the output gate. A missing review or `{status: "pending"}` is an unmet gate; malformed completed review metadata is an input error. At least one actual rendered output review is required; no-output cycles cannot establish editorial output quality. Discovery success is never substituted for rendered-text quality.

Three distinct nonempty scheduled cloud cycles with full coverage and all candidates complete are required. Every supplied cycle must be complete. Empty checks are separate: at least one complete controlled empty-input check with zero captured candidates and zero outputs, and a complete output inventory, is required. It may run locally, with mocks, or in cloud; it is not a required paid inference run. Empty cycles cannot replace nonempty cycles or contribute to precision/recall. Pending cycles/checks are allowed for honest progress tracking and leave gates unmet. All saved run IDs, including heldout and empty checks, must be distinct.

A completed controlled empty check has `{id, status, invokedAt, completedAt, evidenceRef, captureRef, environment, controlled: true, modelCalls: 0, costCredits: 0, capturedCandidateIds: [], candidates: [], outputsComplete: true, outputs: []}`. `environment` is `local`, `mock`, or `cloud`; `scheduled` is optional. No model, provider, policy or requestProfile metadata is required because no model call occurs. A configured route may be recorded separately for context. `invokedAt` records workflow/check start, not inference. Unique IDs, ordered UTC timestamps and nonempty evidence/capture references still apply. Nonzero calls or costs are malformed. Deferred/failed checks cannot pass; pending checks may retain only ID/status.

Initial human review cadence is every three hours within existing operational/budget limits. This document creates no schedule and authorizes no new paid action.

The output-review gate reports rendered-text review independently from cycle completion and empty-check inventory gates; aggregate passage still requires every gate.

The report includes `runReports` retaining explicit evidence class (`controlled-empty-input` or `saved-model-inference`), empty-check call counts/environment, self-attested route/cost metadata and artifact references, per-cycle captured/accounted counts, complete/deferred/failed counts and missing candidate IDs. The report exposes component booleans in `gates`, names in `unmetGates`, the heldout scorer's confusion counts/ratios/missing IDs, and `reportedEvidencePass`. It measures reported saved evidence only. Self-attestations and artifact references still require human audit.
