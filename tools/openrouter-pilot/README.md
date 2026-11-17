# Bounded OpenRouter pilot

Node 22 is required (`node:sqlite` is experimental in that release). The default
command only validates credentials, funding, published endpoint capabilities and
a conservative reservation envelope. It does not generate model output:

```sh
npx --yes --package=node@22 node tools/openrouter-pilot/run.mjs --preflight
```

The key is read from `~/.config/warpcore/openrouter-pilot.env`, mode 0600, as
`OPENROUTER_API_KEY=...`. It is never passed through command arguments, stored in
Git, baked into an image, written to reports or sent to GitHub. No key/account
settings or credit purchases are performed. Management/provisioning keys are
refused. A key's spending limit is not proof of account funding.

The campaign ledger and private reports live outside the repository under
`~/.local/state/warpcore/openrouter-pilot-20261115/`. The SQLite ledger fixes the
owner's authorization at 2 USD total/24 attempts across processes, restarts and
UTC days. It reserves/counts before HTTP, permits one in-flight attempt, retains
unknown holds, prevents request-hash replay and records actual overages while
blocking further dispatch. Never delete or reset it to get past a hold or limit.

After reviewed preflight passes and within the existing owner approval, the
explicit one-shot command is:

```sh
npx --yes --package=node@22 node tools/openrouter-pilot/run.mjs --canary
```

The default canary selects the researched GPT-oss-120B/Groq trial route with low reasoning,
pins the exact provider and unit-price ceilings, requires ZDR eligibility, uses strict discovery JSON Schema, and
checks the returned provider identity. It sends the existing public development
cases with neutral IDs; gold labels/rationales are excluded. It has no source
fetch, model tools, publishing path or automatic retry. Each four-story development page is selected explicitly; calls remain single-shot:

```sh
npx --yes --package=node@22 node tools/openrouter-pilot/run.mjs --preflight google/gemma-4-31b-it first-half
npx --yes --package=node@22 node tools/openrouter-pilot/run.mjs --canary google/gemma-4-31b-it first-half
```

Use `second-half` for the remaining four cases and `helion-scope` for the modified
owner-negative regression without the published-summary shortcut. These are
development experiments; the regression is not a newly collected RSS record.
Gemma 31B and 26B remain explicit comparators; Gemma 26B is selected (`google/gemma-4-26b-a4b-it`). Both share the same ledger. Haiku/Luna are historical profiles and are no longer
selectable by this CLI following the owner preference for open models. The
specific route must appear once in the public ZDR feed without Safety Retention,
and each request includes `provider.zdr:true`. This does not change account settings.
These new profiles apply to the local pilot; inactive producer SQL/runtime
activation requires separate integration and verification. A held-out quality
campaign is separate work, not implied by one passing canary.

The reservation uses the endpoint's full advertised context/completion limits
and highest listed token-class rates, including long-context/cache overrides,
rather than guessing tokens from bytes or treating the requested output maximum
as an exact billing bound. This remains conditional on the provider's published
limits and pricing covering all charged token classes. Unknown/new fees or
capabilities fail closed. The controller requests text only with no plugins,
media or paid tools; no model can authorize a budget/routing change.

Known usage is settled independently of report-writing/evaluation failures.
Unknown cost keeps its hold and stops. Reports capture actual model/provider,
generation identity, native usage and decisions privately. A perfect match to the
one-owner/seven-provisional development labels is not model-quality acceptance.

November 16 execution checkpoint: 9 dispatches, 0.002945861 USD reported cost,
no unresolved holds, no publishing/deployment/purchase, and no automatic retries.
Gemma 31B/DeepInfra passed both four-story pages (8/8 development-label agreement)
for 0.0012284 USD in 19.4 and 15.6 seconds. Its separate one-story Helion regression
correctly rejected granular PyTorch scope without the published-summary shortcut.
This is preliminary compatibility/development evidence, not held-out quality or
sustained reliability acceptance. The model is the pilot default, not activated
in the SQL-backed producer or production.

Failures are retained: the original first-party routes conflicted with effective
privacy restrictions; Activity/key metadata reconciled zero reported charges.
Gemma 26B's eight-case decisions were invalid, and its first half passed with one
provisional false positive. An eight-case Gemma 31B call and four-case Gemma 26B
call timed out at 30 seconds. Owner-authenticated Logs identified the generations;
authenticated generation metadata supplied their actual charges before holds were
settled. No timed-out result is counted as a valid completion.

The adapter now retains bounded HTTP classifications, precise decision-validation
issues and audited completion identity without raw failed decisions or messages.
Preflight reports unresolved, duplicate or exhausted campaigns as blocked. The
ledger and original failures must never be deleted/reset to repeat experiments.
See `docs/evidence/2026-11-16-openrouter-canary/result.json` for sanitized evidence.


The hosted Gemma trial later timed out at the unchanged 30-second deadline.
Its SQL uncertain checkpoint/error audit was retained. Refreshed authenticated
Logs showed no matching generation, and the key usage remained exactly unchanged;
the parent recorded zero reported charge without inventing native token usage.
Metadata/key GET probes from the same host/container network succeeded; the
inference timeout cause is unconfirmed. Following the owner's model flexibility,
GPT-oss-120B via Groq is the next candidate, using the same generic four-case
runtime and all existing guards. Profile `2026-11-16.2` requires low reasoning
(the model is a reasoner) and ZDR; prior profiles remain unchanged. The candidate subsequently passed all three local format/coverage trials in
1.30, 1.28 and 0.60 seconds. It agreed with six of eight development
labels (seven provisional) and passed the separate Helion scope regression; those disagreements
remain visible and are not tuned away. A one-call hosted SQL smoke also passed
for 0.00049965 USD. Total campaign spend is now 0.005004461 USD over 14 attempts,
with no global unresolved holds. This supports the development candidate and
technical plumbing, not autonomous editorial or publishing qualification. See
`docs/evidence/2026-11-16-strix-halo-paid/`.
