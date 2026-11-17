# Hosted staging evidence

This records deployment into the existing News Digest project on November 16,
2026 (Eastern). No new Supabase project, paid service or plan upgrade was created.
It does not establish production cutover or autonomous publication acceptance.

## Installed, disabled foundation

- Ranked state, audit, producer and selection contracts installed successfully.
- Private runtime bootstrap installed; both bootstrap RPCs return disabled while
  the producer is off. Anonymous and authenticated roles cannot execute them.
- Combined five-story admission installed on both inbox and publications without
  changing queue rows. Existing queue was empty at the preflight.
- Fenced lease release installed; anonymous execution denied.
- `news-agent` deployed as version 1, platform JWT verification enabled,
  bundle SHA-256 `1a38fdf1ba0e287a24c2b8cf0a98cc88c9f59d929847368594235d3700bb76b7`.
- Distinct minute continuation schedule installed inactive. A disabled enqueue
  returned null. Existing collector, curator, publisher and reader schedules
  remained active.
- Credentials are private Vault secrets; no credential values are repository
  artifacts. The standard Supabase service role remains trusted server authority.

## Actual hosted network acceptance

A fixed-destination, JWT- and token-protected diagnostic function used the same
public evidence transport. Supabase returned HTTP 200 with `ok:true`, 577 bytes,
content SHA-256 `25ddf2c883e0d1958ea971d279a7e4f0fd446724ee3db7db19dadabd4a62e484`
and `factsVerified:false` for `https://example.com/`. No model was called.

Probe version 1 bundle SHA-256:
`2dfdbeb4bb7b4678fa9dedc7a393d8b010cc757a19a7d0ac395e63d1a32d4d9b`.
The destination is fixed in code; the request cannot select a URL or operation.
This establishes actual hosted DNS/TCP/TLS availability. Halo separately tested
wrong-host certificates, private DNS, bounded framing and real public documents.

## Existing pipeline and source health

Deployed curator version 5 and publisher version 11 matched tracked dependency
files; their entrypoints differed through their enabled switches. Redeployment
must preserve those switches and account identity.

All 43 configured sources attempted collection within the preceding two hours.
Their durable coverage outcomes were 37 historical gaps, five partial catch-ups
and one failure (`source_http_403` for Perplexity). Recent attempts do not establish
historical coverage; these outcomes must remain visible as degraded coverage.

## Local and host composition

The current checkpoint passed 213 JavaScript tests and the complete embedded SQL
suite. Real Halo PostgreSQL 17.6 exercised shared admission races and the complete
RSS receipt/handoff/curator flow, including recovery after a lost finish response.
Native repost composition uses actual SQL with fabricated AppView/model HTTP;
no native live-source or public-display acceptance is claimed here.
