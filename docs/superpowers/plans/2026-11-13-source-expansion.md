# Warp Core Source Expansion Implementation Plan

**Goal:** Add seven verified public discovery sources without widening publishing authority.
**Architecture:** Extend the existing exact RSS allowlist and pinned-DID roster. Raise discovery capacity to 40 with four bounded workers; preserve the 120-second scheduler budget, review gates and five-post/hour limit.
**Spec:** Owner's November 13 continuation request and `docs/warpcore-sources.md` editorial scope.

## Constraints and review focus
- No secrets, credentials, publisher, schedule or security changes.
- Reject unsafe XML, redirects, oversized feeds and mismatched Bluesky identity as before.
- The Race uses the same selected-team title/lifestyle filter as Motorsport.
- Mixed-topic sources are discovery only, never automatic publication approval.
- Runtime must retain deterministic order, isolated source failures and one HN scan.

## Tasks
- [x] Add failing roster, exact-destination, F1 filtering and four-worker/cap40 tests.
- [x] Add six verified RSS feeds and TechCrunch pinned native source; update bounded scheduler.
- [x] Run local safety tests, update source docs, obtain independent review and CI.
- [x] Merge verified change; deploy only collector preserving its existing activation/auth; verify exact bundle read-back.
- [ ] Confirm source results from the first scheduled collection at 16:17 UTC.
