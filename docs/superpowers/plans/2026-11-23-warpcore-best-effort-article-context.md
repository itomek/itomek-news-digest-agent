# Warp Core Best-Effort Article Context Implementation Plan

**Goal:** Fetch the original publisher article for selected stories when possible, and always fall back to the source title and link when the fetch or excerpt fails.

**Architecture:** Keep the existing single relevance call and publication guards. After selection, try a short, parallel, credential-free fetch of each article using the existing approved public network transport. Use one short publisher excerpt when it fits; never make fetching, extraction, or layout of the optional excerpt a precondition for a title-and-link post. Keep writes to the existing durable publication queue.

- [ ] Establish the fallback, valid article, rejected article, and sibling-continuation tests.
- [ ] Render the exact title and link without the old prefix; render at most one safe, short optional excerpt.
- [ ] Wire the guarded article reader into the existing review, leaving the LLM request and spend unchanged.
- [ ] Apply a backward-compatible SQL renderer migration; verify both record shapes match in disposable SQL and do not bypass URL or integrity checks.
- [ ] Run unit, SQL, and CI tests, deploy together if green, and check ordinary production work without a fixture post.
