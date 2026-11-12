# Initial Warpcore editorial scope

Owner direction, 12 November 2026. Source adapters collect **unverified candidates**, not publishable text. No paid model has been selected. Collection does not itself establish correctness, significance or permission to publish.

## Include
- High-level AI model releases; significant agent-framework updates; noteworthy agent libraries/apps with community traction. No intricate model-data/benchmark minutiae.
- Local AI for AMD and Nvidia; meaningful AMD, Nvidia, Arm and Intel hardware launches. Summarize market, intended user and availability, not chip-by-chip trivia.
- Developer platforms, devices and software. Microsoft/Office only when consequential, not routine features.
- Quakertown/Bucks County local news, practical civic changes.
- Pittsburgh Penguins and rolled-up significant F1 news focused on Haas, Cadillac and Mercedes. Driver/team/car changes, not merchandise or lifestyle chatter.

Exclude national politics; local government news may be relevant. HN scores/comments are a **single engagement snapshot**, never proof of acceleration or accuracy. A snapshot threshold is a discovery filter, not automatic editorial approval.

## Attribution
Write original short summaries with source links and a brief explanation of why the change matters. Do not copy posts/articles as our own. Preserve the original Bluesky post URL and URI even when linking its external article. Native reposting may be appropriate, but the current publisher does not yet implement native reposts; do not silently pretend a new post is a repost.

## Verified intake / remaining gaps
Runtime fetch + XML parsing confirmed current items for Nvidia, Supabase, Firebase, Apple and independent Penguins publication PensBurgh. Arm feed parses but had no recent dated entries. F1 official feed lacked publication dates: held rather than assigning fetch time as news date. GitHub feed includes a doctype-looking string inside article code and is conservatively held by parser. OpenAI, Omarchy, Microsoft/Windows and Bucks feed requests returned 403 from this runtime; do not bypass protections. Research alternate approved public sources before claiming complete coverage. AMD/Intel coverage remains a gap.

## Launch gates
1. Final pinned source endpoints / public account identities.
2. Review-only collection, persistence and provenance checks.
3. Trusted curation/review mechanism; source text cannot approve itself.
4. Verified preview then publishing activation. Scheduler and publisher remain disabled until this is met.

`news-collect/initial-sources.json` is a **dormant candidate roster**, not wired into the deployed endpoint. It currently covers only the verified subset above plus HN. All source items require editorial scope/significance/fact checking; Nvidia gaming promos and Penguins lifestyle items must not automatically become posts. Selecting this subset does not imply complete topic coverage. The RSS transport accepts only a reviewed exact-URL allowlist, refuses redirects and never fetches item-linked pages; new source URLs require code review.
