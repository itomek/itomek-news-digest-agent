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
