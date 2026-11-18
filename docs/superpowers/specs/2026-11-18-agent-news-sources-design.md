# Agent and product news sources

Approved scope: extend the existing collector with DeepSeek updates, OpenClaw,
Nous Hermes, Pi, JetBrains, general agent news, Hugging Face Posts and the
remaining Grok/space proposal. Prefer public feeds over mailbox subscriptions.
Pi means the coding agent now maintained at earendil-works/pi. Latest owner
steering prefers curated general agent news over raw release feeds: use InfoQ
Agents, OpenClaw blog and Earendil announcements. Hermes is a named editorial
interest via curated coverage; no direct Hermes patch stream is configured.

Use the existing RSS and official HTML adapters and checkpoint transactions.
HF Posts needs a bounded resumable page adapter, adapted from PR #158 rather
than its obsolete whole-window collection loop. Reuse the dated HTML-card
extraction from PR #157 for xAI and Virgin Galactic. Preserve existing sources,
network bounds, JWT lock, provenance, spend and publication guards.

Select high-level agent and JetBrains product/service/model releases and useful
new capabilities. Skip routine patches, internal changes, tutorials and filler.
Community/reporting sources are discovery; do not present them as first-party.

Alternative: newsletter signup and mailbox ingestion would add private account
handling without improving this public-feed path, so no signup is needed.
Reddit remains outside this expansion's public-feed path: the old PRAW ticket
does not supply an active adapter or credentials for the current pipeline.

Verify endpoints without bypassing access controls. Blocked xAI is deferred outside the active roster; its prepared adapter reports
access errors rather than a fabricated empty window. Repository changes and public
fetch checks do not prove deployment or production collection success.
