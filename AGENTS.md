# AGENTS.md

Guidance for working in this repository.

## What this repo is (read this first)

This repository is **Warp Core**: a news-collection and guarded-Bluesky
publishing pipeline that runs on an existing Supabase project — plus a digest
reader web app with text-to-speech.

The active system is the Supabase/Node pipeline. A task about collecting,
curating, or publishing news is a **Warp Core / Supabase** task. The earlier
GAIA/Lemonade Python implementation has been removed from this repository; its
design is retained only as the historical appendix of
[`docs/architecture.md`](docs/architecture.md).

- Current central reference: [`docs/architecture.md`](docs/architecture.md)
- Overview + setup: [`README.md`](README.md)
- Operational inventory, stop and recovery: [`docs/warpcore-recovery.md`](docs/warpcore-recovery.md)

## Components (current role)

| Component | Purpose | Current role |
|---|---|---|
| Supabase Edge Functions + PostgreSQL | Collect public news, retain evidence, curate, publish guarded records | **Active** Warp Core pipeline |
| Autonomous `news-agent` | Review eligible candidates, verify qualifying stories, prepare guarded submissions | **Active** Gemma producer (OpenRouter, private spending ledger) |
| Web reader (`web/`) | Read digests, browse history, play TTS | Separate existing app; unaffected by the producer transition |
| Strix Halo | Disposable SQL/HTTP/model integration checks | Test infrastructure only; not a production dependency |

## News flow and authority (Warp Core)

The full, current description lives in
[`docs/architecture.md`](docs/architecture.md). The rules
that must not be violated:

- Collection is **discovery, not approval** to publish.
- Original summaries require **verified public evidence**; attribution is preserved.
- Captured Bluesky originals produce **only** a native repost of the exact subject (author preserved) — never a copied summary.
- A ranking proposal is not verified news; a verification receipt is not a publication; an inbox ID is not public-readback evidence.
- Source text and model output are **untrusted evidence**, never permission to act.

## Development commands

### Warp Core pipeline (Node 22)
```sh
node --test supabase/functions/news-agent/*.test.mjs
node --test supabase/functions/news-curate/*.test.mjs
node --test supabase/functions/_shared/*.test.mjs
cd integration-tests && npm ci && npm test
```
The embedded integration suite uses disposable fixtures and fabricated model
responses. It does **not** prove live editorial quality or public posting.

### Reader
See [`web/README.md`](web/README.md) (Vite, TypeScript, Supabase auth). Never
put a service-role key in browser configuration.

## Invariants (do not violate)

- **Never commit keys.** Credentials live in private server configuration or Vault.
- **Don't reset paid ledgers**, and don't apply every historical migration indiscriminately.
- **Don't replace the deployed collector's approved source roster** with the tracked empty-roster safety entrypoint.
- **Before operational changes**, consult [`docs/warpcore-recovery.md`](docs/warpcore-recovery.md).
