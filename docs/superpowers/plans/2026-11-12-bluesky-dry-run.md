# Bluesky evidence queue implementation plan

Goal: cloud-compatible, credential-free public Bluesky collection and a review queue, never publishing.
Architecture: a separate CLI uses a fixed AppView HTTPS endpoint, no redirects, bounded response/request counts and existing httpx. A deterministic date/keyword filter is explicitly not factual verification or an AI summary. No legacy runtime dependency.

- [x] Test date filtering, replies/reposts, duplicates, missing/malformed data, unsafe actors and source failures.
- [x] Implement bounded GET transport, record normalization and JSON dry-run CLI.
- [x] Document exact invocation, source curation and remaining credential/publishing gates.
- [x] Run isolated collector tests, compile, lint when available and attempt legacy suite; report limits.
