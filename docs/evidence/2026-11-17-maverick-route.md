# Meta Llama 4 Maverick route — November 17

The operator selected one alternative for a bounded nonpublishing trial after real GPT-oss drafts failed length and qualification checks and a separate NVIDIA/DeepInfra request hit upstream capacity limits. Meta Llama 4 is an American open-weight model; no editorial superiority is assumed.

## Reviewed route

| Control | Value |
|---|---|
| Model / provider | `meta-llama/llama-4-maverick` / `Parasail` |
| Exact route | `parasail/fp8`, only/order pinned, fallback disabled |
| Request profile | `2026-11-17.7`, coded discovery schema v4 |
| Sampling | Temperature 0; reasoning omitted entirely |
| Advertised context / provider maximum completion | 524288 / 32768 tokens |
| Actual request output / review batch | 4096 tokens / 16 candidates |
| Routing prices | 0.35 input / 1.00 output per million tokens; request fee capped at zero |
| Conservative reservation | 0.216269 OpenRouter credits, from full advertised context plus full provider maximum completion |
| Privacy | ZDR required; matching public metadata reports `safety_retention:false` |

The [official Parasail structured-output guide](https://docs.parasail.io/parasail-docs/guides/structured-output.md) lists Maverick and describes server-constrained JSON Schema. Its [model catalog](https://docs.parasail.io/parasail-docs/products/overview/models.md) matches the reviewed [OpenRouter endpoint](https://openrouter.ai/api/v1/models/meta-llama/llama-4-maverick/endpoints) limits/prices. The separate [ZDR listing](https://openrouter.ai/api/v1/endpoints/zdr) confirms the matching endpoint without safety retention. No latency/throughput measurement is available from this preflight; exact-schema operation and model quality still require actual calls.

## Implemented controls and static evidence

The new row is opt-in; the existing GPT-oss default remains unchanged. Both request builders truly omit reasoning and include temperature zero. JS and SQL bind the same model, provider, version, prices, privacy policy, output, batch and reservation. Supplied reasoning, dropped/changed temperature, alternate providers, fallback or price/schema drift fail before dispatch. Verification uses unchanged V7 source, quotation, identity, date, history and rendered-post checks.

The upgrade widens only the private model CHECK and replaces five exact source functions. It requires producer, verifier and submission disabled, preserves existing RPC permissions and private helper revocations, and writes no activation, budget, secret, hold or historical row. Artifact SHA-256: `40cae5bf61790517a44755227233e1d5f76a3f63b22950ccd307a73e22000da8`.

All 536 Node tests, Deno checking, the 37-script embedded suite and additional Maverick native/ordinary/GitHub receipt flows pass. Independent review verified source and artifact. Historical canonical request hashes and defaults remain stable. These tests use fabricated provider responses, not actual model quality.

Existing daily/lifetime limits remain 2/19.99 credits; the new route has its own 0.216269-credit reservation. Old uncertainty is not reset or released. No new service, subscription, provider account or credential is created: calls continue through the existing OpenRouter key. Live deployment, funding/capability recheck and a fresh bounded actual-model trial are next; no launch or public publication is claimed here.
