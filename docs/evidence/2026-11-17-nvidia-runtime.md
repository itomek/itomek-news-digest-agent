# NVIDIA runtime validation checkpoint — 2026-11-17

This is an intermediate checkpoint, not production acceptance.

The discovery-stage `news-agent` v4 bundle was deployed from commit `f1b5f84`, with platform JWT verification enabled. Its sorted source manifest SHA-256 is `d5ca844ced2334b96216f170e82b73aa8806de95c1e1ae35ce0d198583e874ff`; the deployment reports bundle SHA-256 `4b640bff7f2a46b7b6a60fd96245b01182e7c685916182a5d730bc1c6fcf7d28`. This entrypoint excludes verification and publishing. Producer, verification and submission were disabled at deployment.

The reviewed NVIDIA Nemotron 3.5 Super VL / DeepInfra profile `2026-11-17.4` uses coded keyed decisions, explicit provider routing, no fallback, ZDR, reasoning disabled and bounded prices. Its conservative per-attempt reservation is 0.157287 OpenRouter credits. The eight-case development challenge completed in 3.219 seconds for 0.0007039 credits, matching seven provisional labels. These labels are not a held-out set or owner quality approval. Full-feed validation and source verification remain pending.

The previous GPT-oss run reviewed 128 of 649 captured candidates before an upstream HTTP 429 without usage details. The operator quarantined that workflow at revision 27. Its 0.058983-credit reservation remains held, its paid request history remains immutable, and it cannot resume. This is not a zero-charge determination or a replay of the failed request. Its settled cost remains 0.01642485 credits.

The owner-only quarantine and authenticated bounded dashboard alert RPC are installed. The second migration's ledger insert collided with the preceding migration timestamp after its DDL succeeded; installed functions were checked, and a subsequent assertion-only migration recorded that state. Alert delivery remains disabled at this checkpoint.

Validation: 280 targeted Node tests, embedded SQL suite, Deno checks of both entrypoints, and 481 web tests plus build/lint passed locally. Independent profile review passed 50 focused tests and JS/SQL registry parity. Current-head CI remains a separate release gate.

NVIDIA's official model card identifies the permissive OpenMDW-1.1 license. The precise description is an open-weight model; this does not establish public availability of every training artifact.

## Hosted full-feed attempt

After the targeted registry upgrade, the operator selected NVIDIA in the private runtime setting and created a new audited validation run. Discovery captured all 651 eligible candidates. The first 16-candidate, 4,096-output-token request received upstream DeepInfra HTTP 429; no assessments were committed. OpenRouter's authenticated upstream-request view independently showed one failed DeepInfra attempt in 62 ms. Its generation lookup returned 404, so no usage or zero-charge determination was inferred.

The producer and minute continuation cron were paused. The new 0.157287-credit reservation remains held; combined unknown reservations are 0.21627 credits. Verification and submission stayed disabled. The full-feed attempt did not establish editorial acceptance. Further diagnostics compare local and hosted request sizes and preserve bounded upstream classifications without publishing raw error bodies or secrets.

## Provider-capacity diagnosis

A separate local comparison used disjoint captured candidates 16–31, the same reviewed profile and 4,096 output ceiling, a distinct request hash, and the unchanged private pilot ledger. Its single request also returned HTTP 429. The privately retained error classified `provider_error_code=engine_overloaded` and `limit_source=upstream_provider_shared_pool`, with provider DeepInfra. This identifies upstream shared-pool overload for that comparison; it does not establish a Supabase-specific restriction. Its unknown charge remains held in the private pilot ledger. No request was automatically replayed.

Current official OpenRouter endpoint and ZDR APIs list Together for the same NVIDIA model, with structured outputs, response format and reasoning parameters; prompt/completion prices are 0.15/0.50 credits per million tokens. Context/output caps match the existing conservative reservation. A separately versioned, explicitly pinned Together route is being prepared without changing historical billed request profiles or permitting automatic fallback. API uptime figures are vendor metadata, not independent runtime acceptance.

## Reviewed successor and curator readiness

The reviewed Together profile `2026-11-17.5` was deployed in discovery-stage `news-agent` v5 from `d447cf3`. Sorted source manifest SHA-256: `8c832893c8b286b99ba5687ebcf883977ddad8c726502444b90ffa664adf27de`; reported deployment bundle SHA-256: `359b8c5a7c92a2a5f313220c4d737899939a54e5dbcdd6437e0a8a96ef890d5f`. Five targeted SQL functions were upgraded from matching committed source, preserving settings, budgets and historical provider bindings. Fresh private funding checks passed; the local pilot ledger was not reset or reused while uncertain.

`news-curate` v6 was deployed from `f7bce85`, preserving the existing enabled state, legacy Dot identity, account environment, token and JWT requirement. Its receipt-aware handler/service upgrade does not bypass the independent submission gate. Sorted source manifest SHA-256: `63d4675ac8822e0a22576e1ba5e498ad7444160938ac3ad01c7a0bf3371ae030`; reported deployment bundle SHA-256: `fd427e1ace291315003eef90146c5df6e244b85e10495453bd9f5ae999197564`. An authenticated empty-queue invocation returned HTTP 200 with zero processed decisions. This verifies runtime configuration, not an agent handoff or publication.

## Complete live-feed discovery

The Together run completed at 2026-11-17 06:17:07 UTC: 650 captured and assessed candidates, 184 investigation-eligible assessments, five globally ranked proposals, finalized revision 91. All 41 paid batches settled for 0.06916930 credits; the run has no held credits. Existing earlier unknown reservations remain untouched. The producer and continuation cron were paused after completion while nonpublishing verification was prepared. These are investigation proposals, not five verified or publishable stories.

## Initial nonpublishing verification and diagnostic correction

The full runtime was deployed as `news-agent` v6 from `d447cf3` (source manifest SHA-256 `2b3fdd36a6a2450eca04e6eab18fb772cabb4ed0abba9737afe285d6bebf7b09`, deployment bundle SHA-256 `7b31fe95d7edd256a309fcf172460d2efee750bda387563bb71d83038d2f656f`). Verification was enabled with a 0.5-credit job limit while submission stayed false. The completed shortlist was processed through the normal authenticated endpoint after the reviewed selector-precedence correction.

All five jobs deferred, with zero receipts or inbox submissions. Three model calls settled 0.02189120 credits total; two stopped before inference. No new unknown hold arose. Historical code discarded semantic results and fixed final deferral reasons, so these three jobs cannot retrospectively be classified as intentional model rejection versus semantic validation failure. Later instrumentation must not fabricate those missing outcomes.

Independent review identified a previously published EPYC event, a likely previously published Gemini launch, an older unreviewed Lemonade release candidate, and a Fable event whose primary announcement falls outside the seven-day window. AMD's World Labs acquisition has official November 16 primary support. These source/history findings do not reconstruct the missing model decisions.

The GitHub source failure was reproduced with actual Deno acquisition: repeated normal `Set-Cookie` response headers were rejected. Ignoring these unused headers now permits a bounded 193184-byte capture; framing, cookie nonpersistence, DNS/TLS and size checks remain enforced. The captured Ars original has matching URI/CID/author but empty record text; the current native proof contract deliberately rejects that card-only original. Neither exclusion authorized a post.

The diagnostic correction optionally retains bounded structured model results only in private settlement audits. Archival omissions cannot prevent known-usage settlement; NUL/lone-surrogate cases are explicitly omitted for PostgreSQL JSONB compatibility. Public responses expose only fixed reason codes. This changes observation, not the model request or receipt approval rules.

## Second complete cycle and model rejection

The next real hourly discovery slot completed 651/651 assessments for 0.06925995 credits, with no discovery hold. The first instrumented NVIDIA verification returned a structurally parsed but unsupported approval: native-repost mode for RSS evidence, no claims, a timestamp instead of a date, and URL-only duplicate reasoning. The guard deferred it; known cost 0.00679295 credits settled. The next verification timed out, leaving its 0.157287-credit reservation held and its result unknown. Producer and cron were paused; submission remained false. No receipt or public post was authorized.

A reviewed GPT-oss-120B / Cerebras profile `2026-11-17.6` is prepared: Apache-2.0 open-weight model, pinned `cerebras/fp16`, ZDR, no fallback, low reasoning, 8192 output ceiling and 0.076596 conservative reservation. Historical Groq and NVIDIA profiles remain intact. This configuration is not yet a live model-quality result at this checkpoint.

The separately reviewed owner-only verification quarantine preserves unknown status and all financial/audit records, fences the old workflow, and permits other work only after a different reviewed active model is selected. Its audit records the unreleased hold. Disabled-by-default fallthrough uses the existing frozen global ordering and durable jobs for unattempted candidates beyond the initial proposals; it does not rewrite the initial five or retry prior jobs. Five verified stories per run, combined pending capacity and spending guards remain enforced. Activation remains a separate recorded operator action.

## V2 grounded output contract

The first Cerebras V1 check settled 0.01797055 credits and was deferred: its parsed approval used a timestamp and lacked date support. These are concrete gaps in the permissive V1 wire schema, not permission to weaken receipt checks.

Verification V2 (`2026-11-17.verify.2`) makes approval source-specific and requires named support for every editorial field and publication date. Trusted code derives claim text, URLs and hashes from captured inputs, then applies the existing exact quote/hash/date/native checks. Dates come from the permitted UTC-date enumeration. Ordinary-post limits derive from actual attribution links and the existing pure publishing preview; a separate preflight rejects unpublishable content before receipt creation. Historical V1 requests, audit shapes and receipt checks remain supported.

A reviewed primary-source URL policy is intersected with configured network hosts before retrieval or paid work. It admits the roster's reviewed first-party origins and exact official release repositories, not arbitrary secondary coverage or lookalike namespaces. Unsupported sources are held; this is a deliberately bounded provenance policy, not a claim that every unsupported site lacks primary reporting. Native originals retain their separate exact-identity path.

Validation: 494 unit/mock tests and the full embedded SQL suite pass. V2 ordinary and native flows preserve quote/hash/date proofs; the ordinary flow produces an actual 300-grapheme prepared record at combined five-story capacity with legacy Dot coexistence and zero sends. These remain test results, not public-display acceptance. The web fixture benchmark now isolates its synthetic auth boundary while keeping the one-second and 150-card assertions; controlled slow-auth reproduction and five fixture tests pass. Halo's one-shot helper now follows reviewed registry caps and refuses an under-reserved current-model plan.
