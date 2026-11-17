# Release quote support implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Prevent GitHub API metadata and asset inventories from serving as the model's technical-claim support while retaining the complete primary capture.

**Architecture:** Verification V6 segments the existing raw JSON at the exact top-level release-body and publication-date string boundaries. It retains all raw chunks but gives the model distinct allowed quote-ID roles. Canonical reconstruction and trusted result validation enforce those roles before receipt creation; historical V1–V5 bytes remain reproducible.

**Tech Stack:** Existing JavaScript/Deno runtime and PostgreSQL integration suite; no new dependency or service.

**Spec:** The observed failure and editorial HOLD in `docs/evidence/2026-11-17-scheduled-discovery-quality.md`, plus the role constraints below. Implementation is authorized by the continuing issue #159 task and the owner's direction to proceed; these engineering choices are the implementer's, not claimed owner editorial acceptance.

## Global constraints

- Preserve the complete raw capture, exact concatenation, SHA-256, date/identity checks and actual 300-grapheme/3000-byte post guard.
- Preserve V1–V5 canonical requests and their historical immutable accounting.
- Use `2026-11-17.verify.7`, retaining V6 field-role behavior and historical V1–V6 request bytes; change the SQL reservation allowlist only. Existing provider, output-token, reservation, daily and lifetime limits stay intact. Cerebras generic captures allow 120000 bytes, GitHub API captures stay at 100000, and other routes stay at 200000; captures are never cropped.
- Keep automatic publication disabled during implementation and real-model preview evaluation. Do not replay attempted jobs or release unknown holds.
- Technical claims may reference only release-body chunks; publication date may reference only the top-level publication-date value. This is a trusted runtime restriction, not a new SQL entailment proof.

## Review focus

- Nested asset fields and escaped top-level key aliases must not confuse field identity.
- Duplicate target keys must fail closed rather than depend on JSON's last-key behavior.
- Escapes, surrogate pairs and long notes must preserve the exact raw source after segmentation.
- Forged chunk IDs, swapped roles and noncanonical projections must fail before receipt creation.
- Old profiles and generic HTML/native evidence must retain their prior behavior.

## Task 1: Role-bound source projection and result checks

**Files:** `supabase/functions/news-agent/verification-contract.mjs`, `verification-openrouter.mjs`, related runtime/tests and a focused lexical helper if needed. Agent `rank_contract` owns these files.

**Interfaces:** Extend projection/reconstruction with an explicit version. V6 GitHub projections expose `quoteRoles: {content: string[], publicationDate: string[]}` derived from validated raw source fields. The model cannot choose those arrays.

- [x] Add failing tests for metadata-only technical references and date/body role swaps.
- [x] Add lexical cases for nested decoys, escaped keys, duplicate target keys, unusual JSON whitespace, Unicode and multi-chunk notes.
- [x] Implement exact field segmentation, role-bound wire enums, canonical reconstruction and local result checks.
- [x] Run focused tests and compare explicit historical canonical request hashes.

## Task 2: Admission and composed integration

**Files:** `supabase/functions/news-agent/sql/verification-jobs.sql` and `integration-tests/` verification/native/ordinary/GitHub flows. Agent `agent_schedule` owns these files.

- [x] Demonstrate V6 initially fails reservation admission.
- [x] Add only V6 to the reservation profile allowlist; retain V1–V5 and reject V7.
- [x] Exercise real runtime composition: body/date references pass; metadata-only technical references settle known usage but create no receipt.
- [x] Run the full embedded suite and prepare a reserve-only deployment upgrade requiring producer, verifier and submission disabled.

## Task 3: Independent review, deployment and actual evidence

Root owns deployment, evidence and integration; `rank_sql` performs independent read-only review.

- [x] Inspect the whole diff and resolve concrete reviewer findings.
- [ ] Run the full applicable Node suite, Deno check and exact-head CI.
- [ ] Commit the reviewed source; apply the guarded upgrade and deploy its complete dependency closure with JWT and explicit import map.
- [ ] Evaluate a bounded fresh, unattempted ranked candidate through the ordinary authenticated entry point with automatic submission off.
- [ ] Independently review complete text, quoted support, freshness, follow-ups and history; record pass or hold without replacing editorial acceptance with a receipt.

No additional provider tuning, output-cap increase, source expansion, broad parser framework or discovery cache is included. Owner go/no-go, actual public canary rendering/readback and the remaining issue #159 acceptance requirements remain separate gates.

## Reviewed refinement after the first live V6 follow-up

- [x] Add a combined word target and directly supported second-fact guidance in V7 while preserving exact V6 requests and all existing quote-role proofs.
- [x] Permit the complete 108006-byte MLPerf article within a 120000-byte Cerebras bound, with 120001-byte prepay rejection and unchanged API ceiling. Earlier actual Cerebras processing of this article is recorded separately from editorial acceptance.
- [ ] If testing that previously deferred article, allocate one explicitly logged operator diagnostic from an existing completed run's unattempted verify decision, using existing locks, exact state assertions and the normal claim/inference/receipt pipeline. Do not rewrite its closed current-run job, rankings, cutoff, timestamps, attempts or finances; do not report operator selection as autonomous-ranking acceptance.
