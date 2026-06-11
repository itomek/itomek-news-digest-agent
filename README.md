# News Digest Agent

A [GAIA](https://github.com/amd/gaia)-based agent that produces personalized news digests by scraping curated sources, summarizing them with a local LLM, and publishing to Supabase — plus a mobile-first web app for reading and listening to the digests.

Runs fully self-hosted on AMD hardware (Strix Halo) using [Lemonade Server](https://github.com/amd/lemonade) for local inference — no cloud LLM costs.

## How It Works

The system has three moving parts: a **trigger** (today a manual CLI run, soon a scheduler), the **agent pipeline** that produces a digest, and the **web app** that consumes it.

### Triggering a run

Today, runs are triggered manually:

```bash
python -m news_digest "Generate the AI model releases digest for today"
```

In production (Epic 4, in progress), an **APScheduler daemon** replaces the manual trigger. It registers two cron jobs — a daily slot and a weekly slot, with times configured via `.env` (`SCHEDULE_DAILY_HOUR`, `SCHEDULE_WEEKLY_DAY`, etc., all UTC). When a job fires, the scheduler queries the `digest_topics` table in Supabase, checks each enabled topic's cadence against its last successful run, and invokes the agent once per due topic. The daemon itself runs unattended under systemd (`systemd/news-digest.service`) on the Strix Halo box.

### The agent pipeline

Each run, `NewsDigestAgent` (a GAIA `Agent` with `DatabaseMixin`) executes this flow:

1. **Read topic config** — the agent calls `fetch_topic_config` to load the topic's sources, cadence, and prompt hints from Supabase (`digest_topics` table). Nothing is hardcoded.
2. **Scrape sources** — the agent calls the scraping tools (`fetch_rss`, `fetch_html`, `parse_article`) to gather articles, with polite per-domain rate limiting.
3. **Summarize** — the local LLM (via GAIA's `LemonadeClient`) *is* the summarizer. The agent's own reasoning condenses the scraped material into a structured digest; there is no separate summarizer module. The model returns the finished digest as a JSON final answer.
4. **Publish** — Python parses the model's final answer and persists it deterministically via `push_to_supabase` into the `digests` table. (Local models don't reliably emit a final publish tool call, so the publish step is driven from Python rather than left to the LLM.)
5. **Log** — every run is recorded through the structured logging envelope to Supabase `system_logs`, with a local SQLite fallback if Supabase is unreachable.

### Reading the digests

The [web app](web/) is a mobile-first reading app (Vite + TypeScript + Supabase, deployed to Cloudflare Pages). It authenticates with email + password + TOTP MFA, lists digests with history navigation, and reads them aloud via text-to-speech with media-style playback controls. See [web/README.md](web/README.md) for setup and details.

## Features & Roadmap

Work is organized into epics, tracked as GitHub issues.

| Epic | Scope | Status |
|------|-------|--------|
| 0–1 Infrastructure | GAIA/Lemonade validation, Supabase schema, config loader, logging envelope, CI | Done |
| 2 First digest | Scraping tools, prompts, publishing, end-to-end manual run of the first topic | Done |
| 3 Web app | Supabase-hosted reader with MFA auth, digest history, TTS playback, global voice/speed settings, media controls | Done (neural TTS pending, see below) |
| 4 Scheduling | APScheduler daemon ([#13](https://github.com/itomek/itomek-news-digest-agent/issues/13)), systemd service ([#14](https://github.com/itomek/itomek-news-digest-agent/issues/14)), run logging & error recovery ([#15](https://github.com/itomek/itomek-news-digest-agent/issues/15)), publish-retry hardening ([#44](https://github.com/itomek/itomek-news-digest-agent/issues/44)), log view UI ([#27](https://github.com/itomek/itomek-news-digest-agent/issues/27)) | In progress |
| 5 Multi-topic | Replicate the pipeline to the remaining topics, incl. world news with sentiment ([#19](https://github.com/itomek/itomek-news-digest-agent/issues/19)) | Planned |
| 6 Observability | Log analytics and source health monitoring ([#20](https://github.com/itomek/itomek-news-digest-agent/issues/20)) | Planned |
| 7 Social signal | Reddit via PRAW as a supplementary source ([#21](https://github.com/itomek/itomek-news-digest-agent/issues/21)) | Planned |
| 8 Feedback | Per-digest feedback and quality tracking ([#22](https://github.com/itomek/itomek-news-digest-agent/issues/22)) | Planned |

How each piece runs:

- **Agent pipeline** — `python -m news_digest "<query>"` for manual runs; the Epic 4 scheduler daemon for production.
- **Web app** — `npm run dev` locally; deployed to Cloudflare Pages.
- **Scheduler & systemd** — `python -m news_digest.scheduler` as a long-lived daemon, managed by `systemd/news-digest.service`. Not functional yet — `scheduler.py` is currently a design stub; the implementation lands with Epic 4.

### Up next: self-hosted neural TTS ([#63](https://github.com/itomek/itomek-news-digest-agent/issues/63))

The web app currently uses the browser **Web Speech API** for playback, and the system voices sound dry and choppy. Issue #63 specs the replacement: a **self-hosted neural TTS engine** (Kokoro or Piper are the candidates) running on the same Strix Halo box as Lemonade, exposed over HTTP. Cloud TTS providers were considered and rejected — self-hosting keeps everything local with no per-use cost, consistent with the project's self-hosted-LLM posture.

The plan, in phases:

- **Phase A** — introduce a `TtsBackend` interface in `web/src/lib/tts.ts` and refactor the current Web Speech path behind it (`WebSpeechBackend`), so the player's queue/skip/pause machinery becomes backend-agnostic. This lands independently with no infrastructure.
- **Phase B** — stand up the TTS service on Strix Halo (`POST /tts {text, voice, rate} → audio`), deployed like the other services.
- **Phase C** — add a `NeuralHttpBackend` that fetches synthesized audio and plays it via `HTMLAudioElement`, with caching per digest and **real seek** (instead of today's word-count estimate). Web Speech remains the zero-dependency fallback whenever the neural endpoint is unset or unreachable, and voice selection surfaces in the global settings menu.

The endpoint URL will come from env (`VITE_TTS_NEURAL_URL`, to be added to `web/.env.example` when Phase B lands) and is absent by default; no secrets are committed.

## Prerequisites

- Python 3.12+
- [GAIA](https://github.com/amd/gaia) installed (`pip install amd-gaia`)
- [Lemonade Server](https://github.com/amd/lemonade) running locally
- A Supabase project with the required tables (see [Setup](#setup))
- Node 20+ (web app only)

## Setup

```bash
# Clone
git clone https://github.com/itomek/itomek-news-digest-agent.git
cd itomek-news-digest-agent

# Create virtual environment and install
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"

# Configure
cp .env.example .env
# Edit .env with your Supabase project URL, service role key, and Lemonade Server URL
```

### Supabase Tables

Create a dedicated Supabase project (not shared with other projects), then apply the migrations in `supabase/migrations/` to create the `digest_topics`, `digests`, and `system_logs` tables with their RLS policies.

### Lemonade Server

Ensure Lemonade Server is running and accessible, and pull the models named in `.env`:

```bash
lemonade-server serve
# Verify (snap installs default to port 13305; native installs use 8000):
curl http://localhost:13305/api/v1/models
```

## Usage

```bash
# Manual single run (for testing)
python -m news_digest "Generate the AI model releases digest for today"

# Web app (from web/)
npm install && npm run dev   # http://localhost:5173
```

Coming with Epic 4 (scheduler implementation is in progress — see [#13](https://github.com/itomek/itomek-news-digest-agent/issues/13)/[#14](https://github.com/itomek/itomek-news-digest-agent/issues/14)):

```bash
# Start the scheduler daemon
python -m news_digest.scheduler

# Production: unattended via systemd
sudo cp systemd/news-digest.service /etc/systemd/system/
sudo systemctl enable --now news-digest
```

## Digest Topics

| Topic | Cadence | Description |
|-------|---------|-------------|
| AI Model Releases | Daily | New model announcements from HuggingFace, company blogs, GitHub |
| Local News | Weekly | Township, town, county government and media |
| AI Company Updates | Daily | Product launches, partnerships, funding from major AI companies |
| Sports team | Weekly | Team news, trades, analysis (non-score content) |
| US/other-country World News | TBD | Major news with sentiment analysis, English and other-language sources |

Topic definitions (sources, cadence, prompt hints) live in the `digest_topics` table in Supabase — adding or tuning a topic is a config change, not a code change.

## Development

```bash
# Install pre-commit hooks (one-time)
pre-commit install

# Run tests (unit only)
pytest -m "not integration" -xvs

# Run all tests including integration (requires Supabase + Lemonade)
pytest -xvs

# Lint and format
ruff check src tests
ruff format src tests
```

Web app tests and lint run from `web/` — see [web/README.md](web/README.md).

## Architecture

See [`docs/architecture.md`](docs/architecture.md) for the full design spec — component map, data model, cross-cutting patterns, failure modes, and epic-to-component matrix.

## License

MIT
