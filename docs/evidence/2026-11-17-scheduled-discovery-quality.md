# Scheduled discovery and model comparison

## Completed current-model run

The cloud-only GPT-oss/Cerebras run `344c83d5-1b8e-48bb-9df6-29d14e013f52` started at 09:37 UTC and finalized at 10:25 UTC on November 17. All 652 captured candidates received durable assessments before global ranking. All 41 model calls settled for 0.17891190 credits with zero held credits on this run. Existing older unknown reservations remain separate. The minute cron, pg_net, Vault and Edge Function performed the work; local paid triggers had stopped. Physical local-computer shutdown was not separately tested.

The run started on runtime v14 and continued on v15 after a backward-compatible verification-only/source-capture upgrade; the bound discovery model/profile/policy remained unchanged. This demonstrates hosted scheduled coverage, not approved editorial quality or publication.

## Frozen diagnostic reference

Sixteen new public cases were independently labeled before their review, using policy and candidate inputs without reading model decisions. The reference was frozen at 09:59:01 UTC with SHA-256 `aae761a5d685d3fda0f9e837dedebb258ad3b77957a43a1ec64a64e2b48fcdbd`. At 09:59:59 UTC, coverage was 240/652 and none of the sixteen had a decision. Labels remained unchanged; they never entered model inputs. Ten cases are clear and six were explicitly gray before observation.

| Model/run | Clear accuracy | Precision for investigate | Recall for investigate |
|---|---:|---:|---:|
| GPT-oss / Cerebras | 8/10 | 2/3 | 2/3 |
| NVIDIA / Together, earlier 650-case run | 9/10 | 2/2 | 2/3 |
| NVIDIA / Together, later 651-case run | 9/10 | 3/4 | 3/3 |

All sixteen candidate objects and hashes match exactly in both NVIDIA runs. Policy `2026-11-14.1` and the coded discovery format are shared; NVIDIA used profile `2026-11-17.5`, no reasoning and 4096 output tokens, while Cerebras used `2026-11-17.6`, low reasoning and 8192. Historical batch peers and times differ. This is a small purposive diagnostic comparison, not a controlled experiment, owner-agreed acceptance campaign or proof of production superiority. The six gray cases are excluded from binary scores. NVIDIA itself changed five actions between its runs.

GPT-oss mistook a routine build matrix for new platform capabilities and missed material NVIDIA infrastructure as unrelated. NVIDIA caught the infrastructure case in both runs but did not consistently skip the routine patch. Some correctly skipped cases still had overly narrow scope reasons. These are investigation decisions, not publication permissions or factual-support scores.

The comparison result hashes are `f97a4b902bc5ddab58a4de6b808f143fb657b6117e1900b80f69629ad96c9ac7` (Cerebras) and `1d64eaecd97d1b4c44c3ab55d60c4b0d2206d2ad784fbfdaea9a47897e753ea1` (paired NVIDIA). Private diagnostic artifacts retain the frozen inputs/labels; no paid comparison call was added.

## Next bounded verification test

The existing approved NVIDIA/Together route is selected for the next nonpublishing test based on this modest diagnostic advantage, lower observed full-scan cost (about 0.069 credits versus 0.179), and its larger published context. Fresh endpoint/ZDR/funding checks confirmed the existing 0.157287-credit reservation, 262144 context, provider identity, price ceilings and safety-retention exclusion. No model, provider fallback, key, budget or paid service is added. The policy and historical request profiles are not tuned to these cases.

NVIDIA returns to its earlier 200000-byte aggregate full-source acquisition limit; Cerebras keeps its 100000-byte capacity mitigation. GitHub API captures remain at most 100000 bytes on either route. No capture is truncated; this byte limit is not a general token-context proof.

A nullable private `ranking_finalized_since` boundary affects only allocation of new verification jobs. The owner pins it directly to the stored finalized timestamp of the completed current run and enables existing ranked fallthrough. Earlier manual validation snapshots remain retained without taking priority over the current rollout. Existing jobs/recovery, all financial/history records, combined global five-story capacity and the per-run five-verified-story limit remain unchanged. Default NULL preserves prior allocation behavior. No ranking, date or original shortlist is rewritten.

An automatically started follow-on Cerebras scan had captured 100 candidates but reviewed none. With producer and cron paused, an exact-revision owner transaction confirmed zero attempts, zero held/spent credits, expired lease and no decisions/selection/verification jobs, then marked it deferred/blocked. Its real UTC slot, captures and binding remain intact; before/after state and cancellation reason were logged. This is an explicitly canceled incomplete scan, not a completed or retargeted paid run.

Validation for the scheduling/source-bound changes: 521 unit/mock tests, full embedded SQL suite, Deno check and independent focused review pass. The new-job boundary is tested at exact stored timestamp precision and leaves historical recovery and global guards intact. Owner rollout approval and a fresh canary receipt are still required before any send; the original sample receipt expired while review was pending.
