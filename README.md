# News Digest Agent

This repository contains Warp Core's news collection and guarded Bluesky publishing pipeline, a digest reader with text-to-speech, and the earlier GAIA/Lemonade digest implementation.

Warp Core runs on the existing Supabase News Digest project. Its collector, Gemma-backed autonomous editorial producer, curation drain and guarded publisher are active, using OpenRouter with a private spending ledger. The owner approved shipping, and the first ordinary post and native repost are published. Eligible stories can move through verification and publication while the remaining feed is reviewed; they do not wait for end-of-feed ranking or an hourly publishing slot. Reviewed workflow recovery now handles the exact recorded shared-pool 429 after backoff while preserving its unknown charge; generic unknown failures still stop for owner recovery. These are dated deployment observations, not a live status check. The repository roster has 55 sources; the historical hosted checkpoint recorded 43.

See [Warp Core architecture and operational status](docs/warpcore-architecture.md) for the central current reference, deployment checkpoint, activation checks and [state-preserving recovery](docs/warpcore-recovery.md). Historical design and test reports are linked there with their limits.

## Components

| Component | Purpose | Current role |
|---|---|---|
| Supabase Edge Functions and PostgreSQL | Collect public news, retain evidence, curate and publish guarded records | Active Warp Core pipeline |
| Autonomous `news-agent` | Review every eligible candidate, verify qualifying stories as batches arrive and prepare guarded submissions | Active Gemma producer with exclusive new submissions and bounded, audited shared-pool 429 continuation |
| Web reader | Read stored digests, browse history and play text-to-speech | Separate existing application; unaffected by the producer transition |
| Python GAIA/Lemonade pipeline | Generate personalized digests using local inference | Earlier implementation and development path; not the current Warp Core production runtime |
| Strix Halo | Run disposable SQL, HTTP and model integration checks | Test infrastructure; not a required production news service |

The active source roster is described in the [source directory](docs/warpcore-sources.md). Collection is discovery, not approval to publish. Original summaries require verified public evidence; Bluesky originals use native reposts with their author and subject preserved.

## Development

Use Node 22 for the news pipeline tests:

```sh
node --test supabase/functions/news-agent/*.test.mjs
node --test supabase/functions/news-curate/*.test.mjs
node --test supabase/functions/_shared/*.test.mjs
cd integration-tests
npm ci
npm test
```

The embedded integration suite uses disposable fixtures and fabricated model responses. It does not prove live editorial quality or public posting. Independent PostgreSQL/PostgREST tests and live acceptance have additional prerequisites documented in the [architecture reference](docs/warpcore-architecture.md).

For the reader, follow [web/README.md](web/README.md). It uses Vite, TypeScript and Supabase authentication. Never put a service-role key in browser configuration.

For the earlier local digest implementation:

```sh
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env
# Configure the existing project's local development settings privately.
python -m news_digest "Generate the AI model releases digest for today"
```

That path requires Python, GAIA and a reachable Lemonade Server. Its [original architecture](docs/architecture.md) and systemd files describe the earlier local digest design; they are not instructions to activate or replace the current Supabase publishing pipeline.

Credentials stay in private server configuration or Vault. Do not commit keys, reset paid ledgers, apply every historical migration indiscriminately, or replace the deployed collector's approved source roster with the tracked empty-roster safety entrypoint.

## License

MIT
