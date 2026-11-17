# Gemma deployment — November 17

The owner directs deployment with an inexpensive American model, excludes NVIDIA and Meta from further use, and accepts minor writing/model imperfections rather than a perfection-based launch hold. The operator selects `google/gemma-4-26b-a4b-it` through PrimeIntellect and will show actual generated samples. Earlier proposed formal precision/recall targets are not claimed owner-agreed or achieved. Public-source, account identity, hard platform limits, source attribution, spending and no-duplicate/no-replay controls remain enforced.

## Route and boundaries

- Exact route `primeintellect/bf16`, provider `PrimeIntellect`, new immutable discovery profile `2026-11-17.8`, coded schema v4, reasoning disabled.
- Current routing prices 0.10/0.30 per million input/output tokens, request fee capped at zero, no fallback, supported parameters required and ZDR without safety retention.
- Advertised context 262144 and maximum completion 32768; requests use at most 4096 output tokens and 16 review candidates.
- Conservative full-context/full-provider-output reservation: 0.036045 OpenRouter credits. Existing daily/lifetime limits remain 2/19.99.
- The old `2026-11-16.1` Gemma quote/profile remains historical data; its earlier 0.06/0.18 routing prices are not used as current prices.

Verification V8 adds a trusted server UTC clock and date window to system instructions while preserving existing source/quotation/identity/date/history proofs and the 300-grapheme/3000-byte complete-post guard. The prompt's budget includes actual URLs, attribution and spacing. Historical V1–V7 request formats remain recorded; no prior ledger is reset.

Active JS model selection and private SQL selection allow only GPT-oss and Gemma, with Gemma to be selected explicitly. Fresh NVIDIA/Meta requests and reservations are rejected, including before pilot ledger access. Their profiles, prior requests and unknown financial holds remain historical records; late accounting is not disabled.

## Verification

All 539 Node tests and Deno checking pass. The 37-script embedded suite and additional Gemma native/ordinary/GitHub receipt flows pass. Independent review confirms the exact three-function upgrade and active model CHECK. Artifact SHA-256: `4ac184c8ec56afc063ed8ef7f15a85025e2a8c58dedeb3f0d5e826344afdff53`.

These static tests use fabricated provider responses. Deployment, fresh capability/privacy/funding checks and actual Gemma samples are recorded separately below. No new infrastructure, subscription, account or credential is needed.
