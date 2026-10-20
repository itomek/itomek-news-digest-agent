# Portable collector (first slice, issue #129)

This additive collector reuses the fetching, RSS/HTML/article/PDF separation and
polite limits of `tools/scraping.py`, without importing its GAIA decorators,
Supabase logging, settings, model, scheduler or portal. The legacy app is unchanged.
This is a CLI evidence adapter, **not an installed dot/MCP connector**.

## Run

Python 3.11+ and HTTPX are required. In a dedicated environment:

```sh
python -m venv .venv-collector
.venv-collector/bin/python -m pip install -r requirements-collector.txt
PYTHONPATH=src .venv-collector/bin/python -m news_digest.collect \
  --config examples/collector-sources.json --since-hours 24 --output collected.json
PYTHONPATH=src .venv-collector/bin/python -m unittest discover -s collector_tests -v
```

Use `httpx[socks]` when the environment's approved proxy requires SOCKS. Never
remove a configured proxy to work around a failure. Optional `trafilatura` improves
article extraction; otherwise output explicitly says `html_visible_text` (includes
navigation). Optional `pypdf` enables PDFs, limited to 50 pages. These optional
extractors are not required for feeds, HTML or Hacker News. No keys are needed.

## JSON contract v1

Config is an object with `schema_version: 1` (default), `max_articles` (1–200,
default 50) and `sources` (1–30 objects). Each source has a unique `id`, `type`,
optional `topic`, `url` and `limit` (1–50, default 10).
Types: `rss` (RSS/Atom), `html`, `article`, `pdf`, `hn`, `reddit`.
`html` optionally accepts `follow_links` (1–10), for same-origin, one-hop discovery
only. It checks robots.txt before discovered links; unavailable robots fails closed
for discovery but retains the listing. Curated URLs are explicit source allowlists;
redirects to other hosts are rejected, requiring the final URL to be configured.
Reddit always reports `unavailable` in this slice: no authenticated adapter exists.
HN is top stories metadata, not article fetching or an exhaustive topic search.
The example ROCm feed comes from migration 0018; it remains a candidate, not a
claim of fresh validation. The example is illustrative, not a complete source list.
Selectors/relevance terms/prior-run IDs are not implemented yet.

Output has `schema_version`, `run_id`, `generated_at`, `since_hours`, `articles`
and per-source states. Articles carry stable canonical-URL SHA-256 IDs, canonical
and original URLs, title, text, publication date (nullable), `date_status`, explicit
extraction method and provenance (source ID/URL, topic, fetched timestamp).
HN has `evidence: community_signal` plus score/comment/time/discussion signals;
other content is `source_content_unverified`. Neither is a verified factual claim.
Same canonical URLs merge provenance, not duplicate articles. Cross-URL content
and cross-run deduplication are not implemented. Publication dates outside the
window are removed from feeds/HN; undated HTML/PDF is retained as unknown, **not
represented as fresh news**. Article extraction dates are informational in this slice.

Source status is `ok`, `empty`, `partial`, `error`, `unavailable` or `skipped`.
A failed source is not an empty news window. JSON goes to stdout or `--output`;
diagnostics go to stderr. Exit 0 means at least one usable/empty/partial source,
1 means no usable sources, 2 means invalid config/environment setup.

## Bounds and security

Defaults: 100 requests, 180-second cooperative network budget, 2 MB response,
15-second request timeout, 3-second connection timeout, 1.5-second host spacing,
three attempts for transport/transient errors only, six redirects, 20,000 output
text characters per article. 403 and other deterministic denials are not retried.
No authentication, bot-block or paywall bypass. No child processes or instructions
from content are executed. Treat all collected content as untrusted evidence.

Public-address DNS checks apply to initial requests and every redirect. DNS lookup
failure is a visible source failure. This is **not DNS-pinned transport**: rebinding
is not fully prevented. DNS resolution and optional parser CPU are not hard wall-
clock bounded. Run only trusted curated configurations with enforced outbound
network restrictions; do not expose this as a public arbitrary-URL fetch service.
A hardened deployed runner needs pinned/egress-enforced destinations, parser process
limits and credential handling review. Proxy-only DNS runtimes need a vetted
resolver/transport design, not removal of the safety guard.

## Proxy-side DNS for two fixed public sources

`--fixed-public-sources` is an explicit alternative for this cloud proxy runtime.
It permits **only** `https://hacker-news.firebaseio.com` and
`https://lemonade-server.ai`, on port 443, with no URL credentials. It rejects
all redirects, including same-host redirects. Hostnames are exact, code-pinned
public sources, not a caller-supplied allowlist. It preserves the environment's
proxy settings and delegates DNS to that approved transport. It does not solve
general spidering, cannot fetch arbitrary linked article hosts, and cannot be
used to extend source coverage without code review. The normal mode still
requires public local DNS answers. Both modes retain all request/content bounds.

## Verified in the development workspace

Seventeen isolated fixture tests passed on Python 3.12/httpx 0.28.1, without GAIA,
Supabase or models. Compile checks also passed. Tests do not load the legacy
`tests/conftest.py`. The first strict-mode live run failed closed at local DNS
resolution (`Temporary failure in name resolution`), correctly outputting source
errors. With the documented fixed-source mode and official socksio 1.0.0 installed
in an isolated temporary venv, a bounded run fetched two HN stories plus the
Lemonade homepage (three records, two successful source states). The HN limit was
2, so this made four requests total, not a broad crawl. No proxy settings changed.

Reproduce this bounded check with a config containing HN limit 2 and Lemonade
HTML limit 1, then append `--fixed-public-sources` to the command above. The full
example's ROCm feed is intentionally unsupported in fixed-source mode. Live
content changes over time; undated homepage text is not daily news evidence.
Legacy integration tests and a clean standalone install were not run. Issue #129
remains open for full acceptance. No deployment, scheduler, persistent credentials
or audio service was configured. Natural neural audio and audible delivery remain
separate gates; there is no robotic fallback.
