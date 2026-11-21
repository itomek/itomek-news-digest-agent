# Verification correctness implementation plan

**Goal:** Address concrete correctness gaps and reconcile remaining acceptance work for issue #162.

**Architecture:** Keep SQL history and guarded submission contracts intact. Reuse public-original validation at capture and final send; bind native attribution URLs to the frozen original identity. Preserve pinned, bounded, credential-free network retrieval.

**Spec:** https://github.com/itomek/itomek-news-digest-agent/issues/162

## Tasks

- [x] Correct the versioned editorial policy to require all published and unresolved history, including pending/leased decisions. Verify request consumers and policy fingerprint tests.
- [x] Reproduce final native recheck acceptance of same-identity but newly restricted or malformed originals. Share existing public-original guards across capture and sender; verify no remote writes for rejected originals.
- [x] Reproduce unrelated native attribution URL acceptance. Require bsky.app routes matching the frozen DID and record key, accepting literal and percent-encoded DID paths. Test failures before implementing.
- [x] Exercise complete paginated history, old publications and unresolved states, including fail-closed oversize/snapshot-change cases; retain #194 bounded lock recovery.
- [x] Run relevant unit and disposable database integration suites, independently review the combined diff, and record acceptance evidence and limitations. Semantic entailment/dedup quality must not be claimed from mocked approvals.

## Constraints and review focus

Never truncate required history. Do not replay paid or mutating RPCs. Preserve exact URI/CID/author, raw source hashes, quote bindings, date windows, SSRF/redirect defenses and attribution. Keep production deployment and paid model evaluation outside local verification.
