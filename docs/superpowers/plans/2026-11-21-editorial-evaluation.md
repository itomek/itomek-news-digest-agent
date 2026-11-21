# Editorial evaluation implementation plan

**Goal:** Make issue #164's agreed quality targets measurable offline without claiming that regression fixtures establish a formal campaign pass.

**Spec:** https://github.com/itomek/itomek-news-digest-agent/issues/164

**Architecture:** Extend the existing saved-decision scorer; add a separate campaign manifest validator and human editorial rubric. Keep production prompts, model routes, publication guards and budgets unchanged.

**Constraints:** No paid inference, public canaries, deployment, automatic policy mutation or invented independent labels. Precision and recall targets are each 90%; observed unsupported, duplicate and misattributed outputs must each be zero. Three scheduled cloud cycles and separate empty checks remain evidence requirements.

## Tasks

- [x] Extend evaluation.mjs and tests with explicit confusion counts, precision/recall denominators, missing-positive accounting and undefined-ratio handling. Preserve current result fields and model-input label exclusion.
- [x] Add offline campaign module/CLI and tests: frozen independent 20-case manifest, canonical label digest, evaluation-time ordering, actual route/policy/cost/retrieval metadata, full captured candidate coverage, three scheduled cycles and separate empty checks. Report component statuses; never authorize publishing or assert independently verified quality.
- [x] Add versioned human editorial rubric and review fixtures/documentation. Distinguish provisional/public-source examples from independent held-out labels; retain the exact vague-summary regression.
- [x] Add targeted complete-rendered-text boundary regressions through existing publishing helpers; retain fail-closed behavior.
- [x] Run relevant local suites, independently review changes, fix findings and document remaining hosted/public evidence gaps.

## Review focus

Missing positives must not disappear from recall. Empty sets must not earn perfect quality. Frozen labels must not enter model input. Self-attested metadata must not become a claim of independent review. Existing nine-case fixtures must not be silently promoted into the 20-case campaign.

## Execution record

Repository work started on the clean task branch `work` in the provisioned workspace and is retained on `codex/issue-164-editorial-evaluation`. The branch was updated to `main` commit `83621c8` before final verification. Parallel agents own disjoint files; controller integrates and reviews. Baseline: evaluation.test.mjs, 18/18 passed. User explicitly requested agent fanout; issue supplies the agreed targets and constraints.

Review corrections: controlled empty checks make zero inference calls; cost units are OpenRouter credits with explicit unknown failed/deferred costs; candidate records distinguish discovery decisions from attempted retrieval; scheduled cycles retain distinct producer slots. These are evidence schema corrections, not production behavior changes.

Final verification on the combined tree: 627/627 unit/mock tests passed, including 27 campaign/CLI tests. Embedded SQL suite passed with 55 PASS lines. Focused scorer/guard/rubric review and final whole-change review approved; all reported blockers fixed. Formal campaign evidence and public-display requirements remain pending as recorded in the evidence status document.
