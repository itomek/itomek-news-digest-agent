# Approved pilot billing preflight — November 15, 2026

Authorization: at most 2 USD-equivalent OpenRouter credits total and 24 paid
single-flight calls, no paid project upgrade or account topup. No paid calls or
charges have occurred. Hosted project creation failed at the free-project quota;
no existing project was modified. A dedicated pilot key is not configured locally.

Official documentation says max_tokens generally includes reasoning and visible
output, but qualifies this as most providers; even its example exceeds a requested
300-token maximum by two. Therefore 2048 requested output tokens is not an exact,
universal billing proof. Hiding reasoning does not disable or avoid its charge.
[Reasoning](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)

Current metadata advertises reasoning effort none for Haiku 5.5 and Luna; Gemini 3.8
requires reasoning. The code-owned profiles now explicitly request none for the
first two, include it in the immutable config/request hash, and leave Gemini
unset. Actual provider compliance remains untested.
[Model metadata](https://openrouter.ai/api/v1/models)

No documented OpenRouter pre-generation native-token counting endpoint was found
in the official API index. Do not call a provider directly or infer native tokens
from wire bytes. Revalidate this before the first canary.
[API index](https://openrouter.ai/docs/_llms/api-reference.txt)

A conservative metadata scenario for Anthropic Haiku uses its entire 1,000,000
context and 128,000 maximum completion, rather than assuming that our request will
reach its requested token ceiling exactly. At the highest advertised input class
including long-context one-hour cache writes (1 USD/M) and output rate (2.50 USD/M),
the modeled envelope is 1.32 USD. This is NOT a guarantee: it requires proof that
those maxima/rates cover all charged classes for the pinned endpoint, and that
all additional tools/plugins/media/request fees are excluded. Re-fetch endpoint
metadata before choosing a reservation; stop if that proof or the remaining
2-credit campaign allowance is insufficient.
[Endpoint metadata](https://openrouter.ai/api/v1/models/anthropic/claude-haiku-5.5/endpoints),
[cache behavior](https://openrouter.ai/docs/guides/best-practices/prompt-caching)

A key/workspace limit is defense in depth, not the campaign ledger. OpenRouter
upfront in-flight holds are conditional on account/balance and exclude some fees;
workspace budgets can be exceeded by already-dispatched work. Maintain one shared
campaign ledger across UTC days, decrement the 24-call allowance before HTTP,
settle before the next request, and retain the whole reservation on uncertainty.
No concurrent or unrelated use of the pilot key is allowed.
[Limits](https://openrouter.ai/docs/api_reference/limits),
[workspace budgets](https://openrouter.ai/docs/guides/features/workspaces/workspace-budgets)

These are cited contracts and a calculated scenario, not measured native tokens,
actual provider billing or achieved hosted acceptance. The free-slot decision,
dedicated credential setup, reservation verification and hosted synthetic spike
must precede the real-model campaign under the approved sequence.
