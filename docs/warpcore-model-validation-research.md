# Issue 161: model and hosted validation research

Decision date: November 14, 2026. Audience: owner and implementation reviewer.
Status: research and credential-free measurements; no paid/model or hosted test
has run. PR #166 was merged prematurely relative to the owner's clarified target.
Its producer remains disabled. A follow-up implementation must stay unmerged
until the agreed issue #161 acceptance gates pass.

## Recommendation

Test `anthropic/claude-haiku-5.5` first, compare `openai/gpt-5.6-luna` on identical
blind inputs, and retain `google/gemini-3.8-flash` as a third candidate if needed.
This shortlist uses current pricing, endpoint capabilities and the vendors'
stated task fit; it is not a claim of editorial quality. Select the cheapest
candidate meeting the reviewed quality bar after measurement, or select none.

| Candidate / provider allowlist | Uncached USD per million input / output tokens | Relevant condition |
|---|---:|---|
| Haiku 5.5 / `anthropic` | 0.10 / 0.50 | Above 100k prompt tokens, 0.50 / 2.50 |
| GPT-5.6 Luna / `openai` | 0.20 / 1.20 | Above 272k prompt tokens, 0.40 / 1.80 |
| Gemini 3.8 Flash / `google-ai-studio` | 0.75 / 3.75 | Currently promotional; fail closed if price changes |

Pricing is cited, not measured billing. Sources: [Haiku](https://openrouter.ai/anthropic/claude-haiku-5.5),
[Luna](https://openrouter.ai/openai/gpt-5.6-luna),
[Gemini](https://openrouter.ai/google/gemini-3.8-flash).
These model pages list release dates October 7, July 9 and September 2, 2026,
respectively; metadata was retrieved November 14. The compact
[evidence snapshot](evidence/2026-11-14-model-research/endpoint-preflight.json)
records the specific endpoints, parameters and prices rather than an unspecified
model-catalog top provider. Docs without a publication date below were retrieved
November 14, 2026.

## What was tested without spending

The actual request builder/serializer at merged commit 5713078 was measured using
Node 22. The eight recorded cases produce 10,891 HTTP bytes. The short 405-copy
scaling fixture takes five paged requests; the large 405-case fixture takes 14,
with 2,641,984 total request bytes. These are measured byte counts, not native
token counts or 405 independent real stories. The measurement script accepts an optional checkout/archive directory. To reproduce
the historical numbers, point it at source from commit `5713078`; running without
an argument measures the current checkout, whose corrected schema changes bytes.

```
npx --yes --package=node@22 node docs/evidence/2026-11-14-model-research/measure-workload.mjs /path/to/5713078-source
```

[Saved measurements](evidence/2026-11-14-model-research/workload-measurements.json)
include request hashes. Public endpoint preflight found that the selected Haiku
and Luna routes do not advertise `temperature`; the existing unconditional
`temperature:0` with `require_parameters:true` is incompatible with the advertised
capabilities. Gemini's selected route does advertise it. This is a metadata
compatibility finding, not a model HTTP result.

Before paid evaluation, implement/test model-specific parameter profiles, strict
JSON Schema plus local validation, explicit provider `only` and `order`, disabled
fallbacks, price caps, reasoning controls and actual returned provider/model audit.
Disabling fallbacks alone does not freeze provider identity. Catalog prices use
USD/token; provider `max_price` uses USD/million tokens. Official support says
credits are USD-denominated; credit-purchase fees are separate. Sources:
[structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs),
[routing](https://openrouter.ai/docs/guides/routing/provider-selection),
[metadata units](https://openrouter.ai/docs/guides/overview/models),
[accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting),
[credits](https://openrouter.ai/support/).

## Concrete evaluation proposal

Proposed initial authorization: **up to 2 USD-equivalent OpenRouter credits total**,
shared across models and UTC days, **at most 24 single-flight paid dispatches**,
no automatic retries, no fallback, no tools/web search and no credit purchase.
This is a proposed ceiling, not existing authorization. Start with one canary
per candidate before running repeated comparisons. A timeout/unknown charge
retains its full reservation and stops that experiment for reconciliation.

Use at most eight candidates per initial batch and max_tokens=2048, including
billed reasoning only where that bound is documented for the chosen route.
Verify charged-token bounds and every pricing dimension before dispatch; wire
bytes/4 and one-token-per-byte are not established billing bounds. Use the
provider's context maximum as a conservative input bound only if its accounting
and rejection behavior support that bound; otherwise obtain a documented native
counting bound first. Freeze metadata and reserve the resulting worst-case cost
under the campaign/day ledger. If a valid reservation does not fit the 2-credit
ceiling, do not call; revise the proposal rather than weakening the guard.

For scale only, a hypothetical 10k-input/2k-output request at the cited base prices
costs 0.002 Haiku, 0.0044 Luna or 0.015 Gemini credits, before cache/other charges and
higher-tier conditions. These calculated scenarios are not a token measurement,
actual invoice, reservation proof or a promised campaign cost.

The current eight-story set has one direct owner rejection and seven provisional
labels. It is a development set, not held out. Normalize all IDs, separate gold
labels from model input, independently review public-story labels and freeze an
event-group held-out split before tuning. Record TP/FP/FN/TN, complete coverage,
format failures, unsupported verification claims, latency, native tokens and
actual cost on identical cases. Review misses as well as selections. The Helion
negative case remains a separate visible regression. Do not choose a winner from
agreement with provisional labels or a model's own score. Declare the larger
quality sample and thresholds before that campaign; 24 calls is a pilot cap,
not a sufficient-quality sample-size claim.

## Hosted spike

Use a separate disposable Supabase project with synthetic/public data and no
production/Bluesky credentials. A second function in the production project is
not credential isolation: Edge Functions receive privileged project secrets.
Sources: [secrets](https://supabase.com/docs/guides/functions/secrets),
[API keys](https://supabase.com/docs/guides/getting-started/api-keys).

Run authentication/disabled-mode checks first, then an injected fabricated-model
hosted campaign covering 405 candidates, empty input, overlap, interruption,
budget deferral and uncertainty. Use one page/batch per invocation and measure
CPU, memory, duration, coverage, ledger and zero publication writes. Supabase
currently documents 256 MB memory, 2 seconds CPU/request, 150 seconds free/400 seconds paid worker duration
and 150 seconds response idle timeout. Source: [limits](https://supabase.com/docs/guides/functions/limits).

Pin and test one authentication contract. Retain the existing legacy JWT plus
producer token for the first spike unless deliberately migrating to the newer
named-secret authentication pattern. Do not mix the modes or disable JWT based
only on a generic example. Source: [authentication](https://supabase.com/docs/guides/functions/auth).

Only after explicit isolated-deployment approval should setup create a fixture
schema/install manifest and deploy a spike entrypoint. Do not replay production
migrations or modify live schedules. Test scheduled continuation with `{}` bodies
and isolated Vault-held credentials. pg_net temporarily queues decrypted headers;
Vault alone does not make that queue invisible to database login roles. Source:
[scheduling](https://supabase.com/docs/guides/functions/schedule-functions).

Issue161 remains incomplete until hosted and actual-model evidence is recorded.
Discovery review does not prove factual verification, global ranking/dedup,
guarded publication integration or rendered Bluesky quality.

## Evidence ledger

| Claim | Evidence type | Direct support / limitation |
|---|---|---|
| Model prices and supported parameters | Cited endpoint snapshots | Current endpoint metadata, not guaranteed future routing or quality |
| Temperature incompatibility | Metadata preflight | Parameter absent on two selected endpoints; HTTP unrun |
| Eight-case and 405-case byte counts | Measured locally | Actual builder/serializer; no tokenizer or paid inference |
| One owner label/seven provisional/no heldout | Repository fixture audit | Prevents treating development labels as blind acceptance |
| Example costs | Calculated scenario | Explicit assumed token counts/base rates, not reservation proof |
| Hosted limits and project-secret reach | Cited official docs | Hosted runtime behavior still unmeasured |
| Haiku-first shortlist and separate project | Recommendation/inference | Based on sourced prices/capabilities/isolation, not an achieved result |
| Two-credit/24-call ceiling | Proposed authorization | Not yet approved or spent |

## November 15 compatibility correction

The follow-up branch removes unconditional temperature, adds strict discovery
JSON Schema, derives provider allowlists/price ceilings from code-owned versioned
profiles, and binds that profile in the immutable run configuration. The inactive
entrypoint requires a researched profile before any future activation. These are
software contract fixes; actual provider/schema/model behavior is still untested.
Reasoning controls, native billed-token reservation proof, actual returned
provider identity and hosted acceptance still require follow-up before paid use.
The two-credit pilot remains proposed, not authorized by the general request to
fix the issue. No deployment or paid request occurred.

## November 15 owner approval

The owner approved creating/deploying the isolated free spike and the researched
pilot capped at 2 USD-equivalent credits and 24 paid calls, with no paid project
upgrade or account topup. This supersedes the earlier pending-approval labels;
research recommendations still do not prove actual model performance. The new
project attempt was refused by the free-project quota. No call or charge has
occurred; see docs/warpcore-hosted-spike.md for the execution checkpoint.
