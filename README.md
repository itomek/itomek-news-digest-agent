# News Digest Agent

A [GAIA](https://github.com/amd/gaia)-based agent that produces personalized news digests by scraping curated sources, summarizing them with a local LLM, and publishing to Supabase.

Runs fully self-hosted on AMD hardware (Strix Halo) using [Lemonade Server](https://github.com/amd/lemonade) for local inference — no cloud LLM costs.

## How It Works

The agent follows GAIA's tool-orchestrated pattern:

1. A scheduler triggers the agent on a configured cadence (daily or weekly per topic).
2. The agent reads topic configuration from Supabase (`digest_topics` table).
3. It calls scraping tools to gather articles from RSS feeds and HTML pages.
4. The local LLM (via Lemonade Server) summarizes the content into a coherent digest.
5. The digest is published to Supabase (`digests` table) for consumption.

## Prerequisites

- Python 3.12+
- [GAIA](https://github.com/amd/gaia) installed (`pip install amd-gaia`)
- [Lemonade Server](https://github.com/amd/lemonade) running locally
- A Supabase project with the required tables (see [Setup](#setup))

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

Create a dedicated Supabase project (not shared with other projects), then run the migration SQL to create the `digest_topics` and `digests` tables. See `CLAUDE.md` for the full schema.

### Lemonade Server

Ensure Lemonade Server is running and accessible:

```bash
lemonade-server serve
# Verify: curl http://localhost:8000/api/v1/models
```

## Usage

```bash
# Manual single run (for testing)
python -m news_digest.agent "Generate the AI model releases digest for today"

# Start the scheduler daemon
python -m news_digest.scheduler

# Production: use the systemd service
sudo cp systemd/news-digest.service /etc/systemd/system/
sudo systemctl enable --now news-digest
```

## Digest Topics

| Topic | Cadence | Description |
|-------|---------|-------------|
| AI Model Releases | Daily | New model announcements from HuggingFace, company blogs, GitHub |
| Bucks County Local News | Weekly | Richland Township, Quakertown, Bucks County government and media |
| AI Company Updates | Daily | Product launches, partnerships, funding from major AI companies |
| Pittsburgh Penguins | Weekly | Team news, trades, analysis (non-score content) |
| US/Poland World News | TBD | Major news with sentiment analysis, English and Polish sources |

## Development

```bash
# Run tests
python -m pytest tests/ -xvs

# Lint
black src/ tests/
isort src/ tests/
```

## Architecture

See `CLAUDE.md` for detailed architecture documentation, GAIA framework patterns, and design decisions.

## License

MIT
