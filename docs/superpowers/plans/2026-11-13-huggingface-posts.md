# Hugging Face Posts Implementation Plan

Goal: add public HF Posts as unverified discovery without adding project discussion feeds.
Architecture: fixed-origin anonymous GET, newest-first offset pagination to seven-day cutoff, no outbound fetches. Preserve post identity and author plus a linked primary URL. Existing verification, dedup, backlog and publication safeguards remain unchanged.

- [ ] Add failing adapter tests for identity, links, date filtering, pagination, repeated pages, invalid bodies, redirects and oversized batches.
- [ ] Implement minimal collector and register one source; fail closed on incomplete scans instead of silently truncating.
- [ ] Test roster, full Node suites, Python timer and SQL integration tests; independently review.
- [ ] Publish draft PR only, report exact verification and deployment status.

Public frontend API is undocumented and may change. Resource safety failures must not masquerade as successful complete collection. Offset pagination is not a consistent snapshot; repeated items are deduplicated and the next scheduled pass catches later changes.
