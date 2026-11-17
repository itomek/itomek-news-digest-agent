# Maverick route implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Test one American open-weight alternative after GPT-oss failed actual editorial checks and the existing text-only NVIDIA route hit upstream capacity limits.

**Architecture:** Append a single code-owned model/profile and matching private SQL admission. Pin Parasail FP8 through the existing OpenRouter gateway, omit unsupported reasoning controls, bind temperature zero, and retain existing verification V7 and all publishing/accounting guards.

**Tech Stack:** Existing JavaScript/Deno, OpenRouter and PostgreSQL; no new dependency, account or paid infrastructure.

**Spec:** `docs/evidence/2026-11-17-maverick-route.md` records the researched endpoint and limits. Model choice is an operator decision under the owner's OpenRouter testing authorization, not owner editorial acceptance.

## Global constraints

- One model: `meta-llama/llama-4-maverick`, provider `Parasail`, route `parasail/fp8`, profile `2026-11-17.7`.
- Temperature exactly zero; reasoning must be absent, including as an own property.
- No fallback, require supported parameters and ZDR without safety retention; routing prices 0.35/1.00 per million and zero request fee.
- Request output 4096, batch 16, conservative per-request reservation 0.216269 credits; existing 2/day and 19.99 lifetime limits unchanged.
- Preserve historical request bytes, defaults, private grants, source proofs, actual rendered post limits, uncertainty holds and no-replay fences.

## Review focus

Reasoning omission must survive canonical construction and SQL audit. Temperature zero must not disappear through a falsy check. Old profiles must reject the new controls. Wrong routing and known invalid responses must retain billing. Public metadata and schema documentation must not be presented as actual quality or latency evidence.

## Tasks

- [x] Agent `rank_contract`: JS registry/profile, canonical discovery/verification construction, routing diagnostics and regression tests.
- [x] Agent `agent_schedule`: exact SQL model/profile/cap admission, dynamic budget/alert tests, protected upgrade and composed receipt flows.
- [x] Agent `rank_sql`: independent source and exact-artifact review.
- [x] Root: full 536-test suite, Deno check and preservation of unrelated files; isolated test dependencies linked read-only after identifying missing fixture dependencies.
- [ ] Root: commit/rebase onto merged parent, deploy complete dependency closure and guarded SQL, then select the reviewed route with producer/cron/submission paused.
- [ ] Root: fence the distinct DeepInfra unknown attempt using the existing quarantine contract without releasing its hold or retrying it.
- [ ] Root: conduct one fresh normal-candidate nonpublishing trial, inspect actual provider/usage and independently review complete output before accepting any sample.

Formal quality thresholds, owner sample review, actual public canary/readback and production cutover remain separate requirements. No default-model replacement or new arbitrary model-choice interface is introduced.

## Superseding owner direction

The owner excludes NVIDIA and Meta, directs Gemma deployment, and accepts best-effort editorial imperfections. No further Meta/NVIDIA activation or paid test is permitted. Historical records remain for reconciliation. The active implementation and deployment evidence are in `docs/evidence/2026-11-17-gemma-deployment.md`.
