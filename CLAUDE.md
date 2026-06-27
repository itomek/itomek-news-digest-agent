# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project Overview

**News Digest Agent** is a GAIA-based agent that scrapes curated news sources, summarizes content via a local LLM (Lemonade Server on AMD Strix Halo), and publishes digests to Supabase. It is a standalone project that imports GAIA (`amd-gaia`) as a dependency.

**Owner:** @itomek (AMD GAIA contributor)
**Hardware:** AMD Strix Halo, 128 GB RAM, Ubuntu 24.04 — runs 24/7
**Status:** Early development — Phase 0/1

## Architecture

```
                      ┌───────────────────────────────────┐
                      │     NewsDigestAgent(Agent,         │
                      │                  DatabaseMixin)    │
                      │                                    │
┌─────────────┐       │  ┌──────────┐   ┌──────────────┐  │       ┌──────────┐
│  Web Sources │──────▶│  │ @tool    │──▶│ Lemonade     │  │──────▶│ Supabase │
│  (RSS, HTML) │       │  │ scrapers │   │ Server (LLM) │  │       │ (REST)   │
└─────────────┘       │  └──────────┘   └──────────────┘  │       └──────────┘
                      │        │                           │
                      │        ▼                           │
                      │  ┌──────────────┐                  │
                      │  │ DatabaseMixin │                  │
                      │  │ (SQLite)      │                  │
                      │  └──────────────┘                  │
                      └───────────────────────────────────┘
                                   ▲
                                   │
                      ┌────────────────────┐
                      │ APScheduler + systemd│
                      └────────────────────┘
```

### How It Works

1. **Scheduler** (`scheduler.py`) triggers `agent.process_query()` on a cron-like schedule.
2. The agent's **system prompt** instructs it to produce a news digest.
3. The agent calls **scraping tools** (`fetch_rss`, `fetch_html`, `parse_article`) to gather articles.
4. The agent uses its **native LLM reasoning** (via Lemonade Server) to summarize — no separate summarizer module.
5. The agent calls **publishing tools** (`push_to_supabase`) to store the digest.
6. The agent calls **logging tools** to record the run in local SQLite via `DatabaseMixin`.

### Key Design Decisions

- **The LLM IS the summarizer.** The agent's own reasoning produces the digest. Don't create a separate "summarizer" module or tool — the prompt handles this.
- **Tools are pure functions.** Each `@tool` function does one thing (fetch RSS, push to Supabase, etc.). Orchestration is the LLM's job.
- **LLM via GAIA's LemonadeClient.** Use `gaia.llm.lemonade_client.LemonadeClient` — not raw httpx. This gives us model management, keep-alive, and native GAIA integration.
- **Config lives in Supabase.** Topic definitions (sources, cadence, prompt hints) are in the `digest_topics` table, not hardcoded.
- **Secrets live in `.env`.** Supabase keys, Lemonade URL — never committed to git.
- **Local state via SQLite.** `DatabaseMixin` handles run logs and article caching. This is the fallback if Supabase is unreachable.
- **Headless first, UI later.** The agent runs on a schedule via systemd. Agent UI integration (via MCP server bridge) is a future phase, not a launch requirement.

### Agent UI Integration (Future — Phase 4)

GAIA's Agent UI (`gaia chat --ui`) does NOT have a plugin system for custom agents.
The routing is hardcoded: RoutingAgent → CodeAgent. To expose this agent in the UI:

1. Build an MCP server wrapper around the agent's tools.
2. Register it in `~/.gaia/mcp_servers.json`.
3. The Agent UI's ChatAgent can then invoke our tools via MCP protocol.

This is explicitly deferred. Do not build MCP server infrastructure until the core pipeline works.

## Project Structure

```
news-digest-agent/
├── CLAUDE.md               # This file
├── README.md               # Project overview and setup
├── pyproject.toml           # Dependencies and metadata
├── .env.example             # Environment variable template
├── .gitignore
├── src/
│   └── news_digest/
│       ├── __init__.py
│       ├── agent.py         # NewsDigestAgent class
│       ├── tools/
│       │   ├── __init__.py
│       │   ├── scraping.py  # @tool: fetch_rss, fetch_html, parse_article
│       │   ├── publishing.py # @tool: push_to_supabase, fetch_topic_config, get_last_digest_date
│       │   └── analysis.py  # @tool: deduplicate_articles (future: sentiment)
│       ├── prompts.py       # System prompt + per-topic prompt templates
│       └── scheduler.py     # APScheduler wrapper
├── tests/
│   ├── conftest.py
│   ├── test_scraping_tools.py
│   ├── test_publishing_tools.py
│   └── test_agent_e2e.py
├── data/                    # SQLite DB (auto-created, gitignored)
└── systemd/
    └── news-digest.service  # systemd unit file
```

## GAIA Framework Reference

This project depends on `amd-gaia`. Key imports:

```python
from gaia.agents.base.agent import Agent           # Base agent class
from gaia.agents.base.tools import tool             # @tool decorator
from gaia.database import DatabaseMixin             # SQLite state management
from gaia.llm.lemonade_client import LemonadeClient # Local LLM inference
```

### GAIA Patterns to Follow

- **Inherit from `Agent`** and optionally mix in `DatabaseMixin`.
- **Register tools** in `_register_tools()` using the `@tool` decorator.
- **Define behavior** in `_get_system_prompt()` — return the system prompt string.
- **Trigger runs** via `agent.process_query("Generate the X digest for today")`.
- See GAIA docs: https://amd-gaia.ai/sdk and https://github.com/amd/gaia

### GAIA Code Style

Match GAIA's conventions:
- **Formatter:** black (line-length 88)
- **Import sorting:** isort (profile="black")
- **Type hints:** Use them. Python 3.12+ syntax.
- **Docstrings:** Google style.
- **Target Python:** 3.12+

## Development Commands

### Setup
```bash
# Clone and install
git clone https://github.com/itomek/itomek-news-digest-agent.git
cd itomek-news-digest-agent
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"

# Configure environment
cp .env.example .env
# Edit .env with your Supabase and Lemonade Server details
```

### Running
```bash
# Single manual run (for testing)
python -m news_digest "Generate the AI model releases digest for today"

# Start the scheduler daemon
python -m news_digest.scheduler

# Via systemd (production)
sudo systemctl enable news-digest
sudo systemctl start news-digest
```

### Testing
```bash
python -m pytest tests/ -xvs                # All tests, verbose
python -m pytest tests/test_scraping_tools.py  # Just scraping tests
```

### Linting
```bash
ruff check src tests
ruff format src tests
```

## External Services

### Supabase (News Digest project — separate from Command Center)
- **Tables:** `digest_topics` (config), `digests` (output)
- **Auth:** service_role key for inserts, anon key for reads
- **RLS:** anon can SELECT; service_role can INSERT/UPDATE

### Lemonade Server
- **URL:** Configured via `LEMONADE_BASE_URL` in `.env`
- **API:** OpenAI-compatible (`/v1/chat/completions`)
- **Model:** TBD — needs smoke test to confirm what's loaded and context window size

### Neural TTS (Google Cloud TTS via Supabase Edge Function — digest playback voice)
- **Function:** `supabase/functions/tts/` proxies Google Cloud TTS behind an OpenAI-style API (`POST /v1/audio/speech`, `GET /v1/audio/voices`); deployed with JWT verification on
- **Secret:** `GOOGLE_TTS_API_KEY` lives in Supabase function secrets — never in the repo
- **Web app config:** `VITE_TTS_NEURAL_URL=https://<project>.supabase.co/functions/v1/tts` in `web/.env` — unset means Web Speech API fallback; client is `web/src/lib/tts-neural.ts`

## Digest Topics

| # | Topic                              | Cadence | Slug              |
|---|------------------------------------|---------|-------------------|
| 1 | AI model releases                  | 24h     | `ai_models`       |
| 2 | Bucks County / Quakertown local    | 7-day   | `local_news`      |
| 3 | AI company/product updates         | 24h     | `ai_updates`      |
| 4 | Pittsburgh Penguins (non-scores)   | 7-day   | `penguins`        |
| 5 | US/Poland world news + sentiment   | TBD     | `world_news`      |
| 6 | Formula 1 (general + Haas/Cadillac) | 24h     | `f1`              |

**Build order:** Topic 1 first (end-to-end validation), then replicate to others.

## Important Constraints

- **Never commit `.env`** — it contains Supabase service role keys.
- **Never hardcode URLs or keys** — always read from environment or Supabase config.
- **Rate limit scraping** — 1-2s polite delays between requests to the same domain.
- **Fail gracefully** — if a source is down, log it and continue with others. Never crash the daemon.
- **Audio-friendly output is a future concern** — don't optimize for it yet. Consumption/delivery method is TBD.
