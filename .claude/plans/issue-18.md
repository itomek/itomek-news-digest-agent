---
type: plan
source-issue: 18
repo: itomek/itomek-news-digest-agent
title: "Add topic: local news (Bucks County / Quakertown, 7d) + PDF extraction tool"
created: 2026-06-03
status: draft
work_type: code-feature
complexity: complex
tdd_required: true
suggested_team_size: 1
estimated_files_changed: 4
test_command: "ssh tomas@t-nx-strx-halo 'bash -lc \"cd ~/src/itomek/itomek-news-digest-agent && git fetch origin && git checkout feat/issue-18-local-news && git pull --ff-only && source .venv/bin/activate && pip install -e .[dev] -q && pytest -m \\\"not integration\\\" -q\"'"
build_command: "ssh tomas@t-nx-strx-halo 'bash -lc \"cd ~/src/itomek/itomek-news-digest-agent && source .venv/bin/activate && pip install -e .[dev] -q && python -c \\\"import news_digest.tools.scraping, pypdf\\\"\"'"
lint_command: "ruff check src tests && ruff format --check src tests"
branch: feat/issue-18-local-news
reflection_iterations: 0
agents_used: [planning, execution, validation]
---

# Plan — Issue #18: local news (`local_news`, 7d) + generic PDF text tool

Hyperlocal sources are small, inconsistently structured, and often lack RSS — and
township meeting material is published as PDF. The durable capability this topic
needs is **PDF text extraction**, which is generically useful, so build that rather
than a BoardDocs-only scraper.

## Architecture decision (orchestrator) — generic `fetch_pdf_text`, BoardDocs only if confirmed
The issue hedges on BoardDocs ("if the format requires it") and on whether Richland
Township even uses it. Resolve the uncertainty by building a **generic
`fetch_pdf_text(url)`** tool (pypdf) that extracts text from ANY PDF (agendas,
minutes), plus HTML/RSS scraping of local news sites via the existing tools. Do NOT
build BoardDocs-platform-specific crawling in this issue — if the real-world run
confirms Richland uses BoardDocs and a stable PDF URL pattern, note it in the PR as
a fast-follow; the generic tool already extracts those PDFs once their URLs are known.
This keeps the issue tractable and the new code broadly reusable.

## Acceptance criteria → evidence
- [ ] Topic seeded (`local_news`, 7d, sources, prompt_hint) → migration `0008`, applied live (orchestrator).
- [ ] Listed sources produce content OR are documented unavailable → real-world run + PR notes; thin coverage is logged, never silent.
- [ ] Meeting-PDF text extracted cleanly → `fetch_pdf_text` unit tests + a real PDF in the integration/real-world run.
- [ ] Thin-coverage failure mode logged clearly → tool logs (existing `log()` pattern) + prompt_hint instruction to state when sources were unavailable.

## File ownership (strict — do NOT touch files outside this list)
- APPEND to `src/news_digest/tools/scraping.py`: the `fetch_pdf_text` tool (and a small private `_extract_pdf_text(raw: bytes) -> str` helper). REUSE `_fetch_document(url, "fetch_pdf_text")` for validate+throttle+fetch, `_now_utc`, `log`. Never raises; returns the page-shape dict below.
- EDIT `pyproject.toml`: add `"pypdf>=4.0,<6.0"` to `[project].dependencies` (alphabetical-ish, near the other parse deps). This is the ONLY file outside scraping/tests/migrations you may edit; no other issue in this wave touches it.
- NEW `supabase/migrations/0008_seed_local_news_topic.sql`. Number is FIXED at 0008.
- NEW/EDIT `tests/test_scraping_tools.py`: add `fetch_pdf_text` unit cases (mock bytes; do not hit the network in non-integration tests). You may add `@pytest.mark.integration` cases that fetch a real PDF (these run only on the host).
- Do NOT edit `agent.py`, `prompts.py`, `publishing.py`, `analysis.py`, `config.py`, `tests/test_prompts.py`, `tests/test_publishing_tools.py`.

## Design — `fetch_pdf_text(url: str) -> dict`
Mirror `parse_article`'s contract exactly so the LLM sees a familiar shape:
- Returns `{"title": str, "content": str, "url": str, "fetched_at": iso, "pages": int}`; on any failure the same shape with empty content + an `"error"` key. Never raises.
- Flow: `raw, err = _fetch_document(url, "fetch_pdf_text")`; if err → `{**base, "error": err}`. Else `_extract_pdf_text(raw)` via `pypdf.PdfReader(io.BytesIO(raw))`, concatenating `page.extract_text()` across pages with `\n` joins; strip; cap to a sane size (reuse the spirit of the 10 MB byte cap — extracted text can be large; truncate to e.g. 200k chars and log if truncated).
- Error handling: wrap pypdf in try/except → log warn + `error="pdf_parse_error: <cls>"`. Empty extraction (scanned/image PDF) → `error="no_text"` (info log), content "".
- Register via `@tool` (auto-discovered on import). Add it to the module docstring's tool list and the `__main__` debug dispatch (`--pdf <url>`), matching the existing style.

## TDD (tests FIRST, then green) — `tests/test_scraping_tools.py`
The file already mocks HTTP via httpx `MockTransport` and patches `_validate_url`/throttle for unit tests — reuse those patterns (read the top of the file first). Unit cases (no network):
1. Valid multi-page PDF bytes → `content` contains text from each page; `pages` correct. Build a tiny PDF in-test (pypdf can write one) or commit a small fixture under `tests/`.
2. Non-PDF / corrupt bytes → `error` set, `content == ""`, never raises.
3. Image-only / no extractable text → `error == "no_text"`.
4. Fetch failure (transport error / non-retryable HTTP) → propagates `_fetch_document`'s error into the dict; never raises.
5. SSRF-blocked URL → blocked before fetch (reuse the existing unsafe-url test pattern).
Integration (host-only, `@pytest.mark.integration`): fetch one real public PDF and assert non-empty `content`.

## Design — `0008_seed_local_news_topic.sql`
Follow `0002`'s shape; `on conflict (slug) do nothing`.
- name `'Bucks County / Quakertown local news'`, slug `local_news`, cadence `'7d'`, enabled true.
- sources (curate; many likely lack RSS → use HTML URLs the LLM scrapes with `fetch_html`, and PDF URLs it reads with `fetch_pdf_text`): Bucks County Herald, Quakertown "The Free Press", Richland Township site / meeting-minutes page, Bucks County Courier Times local section. Include any discovered township-meeting PDF URL.
- prompt_hint: emphasise zoning changes, school-board decisions, township/borough meeting outcomes, local business, community events; instruct to read meeting agendas/minutes via `fetch_pdf_text`; and instruct: *"Coverage may be thin; if sources were unavailable or returned nothing, say so plainly rather than padding."*

## Validation tiers
- **Local (teammate):** `ruff`; code-reviewer subagent (Critical-only). Build a local 3.12 venv if possible for the red→green loop; else note pytest not run locally.
- **Host unit + build (orchestrator):** `test_command` (installs pypdf) + `build_command` (imports pypdf).
- **Real-world (orchestrator):** apply `0008`; `python -m news_digest "Generate the local news digest for this week"`; verify `digests` row + logs (including any "source unavailable" warns); if a real meeting PDF is reachable, confirm `fetch_pdf_text` extracted it; human rating on coverage/coherence. Confirm-or-deny BoardDocs for the PR notes.

## Risks
- Local sites are fragile / may lack feeds → expect drops; document dead sources, never crash (tools already return safe empties).
- Scanned PDFs yield no text (no OCR in scope) → `no_text` is the correct, logged outcome.
- pypdf version API: use `PdfReader` + `page.extract_text()` (pypdf ≥ 4). Confirm against installed version via Context7 if unsure.
