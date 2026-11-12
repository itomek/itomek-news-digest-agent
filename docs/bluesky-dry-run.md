# Warp Core: credential-free review queue

This is the first cloud-ready slice, not a deployed publisher. It reads public
Bluesky author feeds and writes a local JSON review queue. It never signs in,
creates credentials, posts, changes a scheduler or touches the existing audio
brief. It imports neither GAIA nor Lemonade nor Supabase.

Install the existing `requirements-collector.txt` in an isolated environment.
Use `httpx[socks]` if required by the inherited approved proxy; never remove proxy
settings. Prepare a JSON file like this, replacing actors with curated handles:

```json
{"actors": ["warp-core.bsky.social"], "terms": ["AMD", "ROCm", "Lemonade", "inference", "agent", "Supabase", "Firebase"]}
```

The posting account above is only a smoke-test example, not a useful news source.
Verify prospective source ownership and activity before adding them. Run:

```sh
PYTHONPATH=src python -m news_digest.bluesky --config sources.json --output review.json
PYTHONPATH=src python -m unittest discover -s collector_tests -v
```

Optionally pass `--seen seen.json`, a JSON array of AT post URIs. It is read-only;
review does not mark anything published. Within a run, the same URI is deduplicated.
Cross-posted stories with different URLs/URIs still require editorial deduplication.

## Bounds and interpretation

Up to 20 unique sources, one request each, 100 feed entries per source, 15-second
HTTP timeout and 2 MB decompressed response limit. Only the fixed HTTPS AppView
endpoint is fetched, with inherited proxy settings, no redirects, no credentials,
no retries and no external-link fetching. The response limit and timeout do not
constitute a hard total process deadline. Earliest first-slice retrieval is the
latest 100 entries; pagination is deliberately absent, so a busy feed can omit
part of the last day.

Only valid timezone-aware post dates in the previous 24 hours qualify. Replies,
reposts, missing/invalid/future timestamps and unmatched text are omitted. Matching
is case-insensitive substring matching, not semantic ranking. All retained text is
untrusted social evidence and explicitly requires review. No LLM consumes it here.
A source failure is `error`, never `empty`. Exit 1 means every source failed; 2
means bad input or a file error. Zero means some source was available, not that
news was found or fact-checked.

## Next gates

Verify a small source roster, inspect live candidates and choose publishing scope.
The owner has since chosen an hourly Supabase Edge Function without Strix Halo.
Keep it disabled until a dedicated Warp Core app password is authorized and stored
in Supabase function secrets by the owner, and posting content/cadence is approved. Do not
put credentials in JSON, source files, workflow text, chat, artifacts or logs.
App passwords are not narrowly post-only credentials. The existing audio brief
continues until the owner explicitly approves the replacement.

## Verification (2026-11-12)

24 isolated collector tests passed, including seven new Bluesky tests. Ruff,
compile and diff checks passed. A credential-free cloud request to the Warp Core
account succeeded and returned an empty feed. No source roster or useful-news
coverage has been validated yet. The legacy pytest suite was attempted but could
not load its conftest because this standalone environment lacks pydantic; legacy
GAIA/Supabase integration is not verified.
