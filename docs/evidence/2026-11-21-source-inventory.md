# Source inventory and freshness audit — November 21, 2026

Scope: repository configuration and read-only issue evidence for [#136](https://github.com/itomek/itomek-news-digest-agent/issues/136). No deployment, production invocation, signup, credential change or mailbox access was performed. Membership provides discovery only; publication still requires editorial approval and factual verification.

## Reconciliation and evidence limits

`supabase/functions/news-collect/initial-sources.json` contains **55 distinct source IDs**: 44 RSS/Atom, four pinned Bluesky authors, four official HTML indexes, one HN source, one GitHub PR source and one HF Posts source. All six adapter kinds have registered checkpoint collectors in `adapters.mjs`. The tracked `index.ts` intentionally supplies an empty roster. Deployment requires the approved roster-loading bundle; this file alone does not establish an active collector.

[#191](https://github.com/itomek/itomek-news-digest-agent/pull/191) carries forward #157/#158 and describes the nine-source expansion from 46 to 55. Its closed PR record explicitly says production deployment was pending and production collection was not tested. The older November 15 baseline in `warpcore-source-checkpoints.md` records collector version 13, 43 sources and JWT verification at that time. Historical 38/43/48 counts and the old single-top-20 HN description in `warpcore-sources.md` are dated snapshots, not current configuration.

**Current deployed roster, collector/adapter bundle version, JWT configuration, applied migrations, schedules and per-source last retrieval timestamps remain unknown in this audit.** No current deployment read-back was obtained. A closed/merged source PR and past public endpoint checks cannot establish deployment or current health. Adapter code has no separate semantic version: reconcile the deployed module contents and roster against an exact repository commit, alongside the platform collector version. Read back source IDs plus full configuration (including DIDs/terms), not just the total count.

Issue #136 reports HN cursor progress 180→200 on the 12:00 UTC saved snapshot during the November 21 16:00/16:30 collections, and two ROCm RSS HTTP 429 failures. These are attributed issue observations, not new measurements or evidence that all other sources are healthy. HN freshness and RSS rate-limit changes must receive their own tests and later deployment/read-back evidence.

## Tracked roster

The table records configuration identity, public access and discovery role. Every row's current deployed presence and last successful retrieval are **unknown**. No new availability probe was performed. RSS publication/update timestamps, visible HTML dates, Bluesky `createdAt`, HN item time, PR `merged_at` and HF `publishedAt` are freshness signals, not proof a claim is current or verified. RSS/HTML/HN/HF expose finite histories; HTTP 200 does not certify complete coverage.

| Source ID | Adapter / freshness signal | Canonical endpoint or pinned identity | Discovery role / purpose |
|---|---|---|---|
| `amd_press_releases` | `rss` / RSS/Atom date or updated | https://ir.amd.com/news-events/press-releases/rss | Primary project/vendor announcements; AMD News Releases |
| `motorsport_f1_selected_teams` | `rss` / RSS/Atom date or updated | https://www.motorsport.com/rss/f1/news/ | Independent reporting; selected F1 teams |
| `nvidia_blog` | `rss` / RSS/Atom date or updated | https://blogs.nvidia.com/feed/ | Primary project/vendor announcements; NVIDIA Blog |
| `supabase_blog` | `rss` / RSS/Atom date or updated | https://supabase.com/rss.xml | Primary project/vendor announcements; Supabase Blog |
| `firebase_blog` | `rss` / RSS/Atom date or updated | https://firebase.blog/rss.xml | Primary project/vendor announcements; Firebase Blog |
| `apple_newsroom` | `rss` / RSS/Atom date or updated | https://www.apple.com/newsroom/rss-feed.rss | Primary project/vendor announcements; Apple Newsroom |
| `pensburgh` | `rss` / RSS/Atom date or updated | https://www.pensburgh.com/rss/index.xml | Independent reporting; Penguins |
| `hn_discovery` | `hn` / HN item time | https://hacker-news.firebaseio.com/v0/topstories.json | Community engagement snapshot; topic-filtered discovery |
| `openai_news` | `rss` / RSS/Atom date or updated | https://openai.com/news/rss.xml | Primary project/vendor announcements; OpenAI News |
| `google_ai` | `rss` / RSS/Atom date or updated | https://blog.google/innovation-and-ai/technology/ai/rss/ | Primary project/vendor announcements; Google AI |
| `deepmind_blog` | `rss` / RSS/Atom date or updated | https://deepmind.google/blog/rss.xml | Primary project/vendor announcements; Google DeepMind |
| `mistral_news` | `rss` / RSS/Atom date or updated | https://mistral.ai/news/rss | Primary project/vendor announcements; Mistral News |
| `rocm_blog` | `rss` / RSS/Atom date or updated | https://rocm.blogs.amd.com/blog/atom.xml | Primary project/vendor announcements; AMD ROCm Blog |
| `huggingface_blog` | `rss` / RSS/Atom date or updated | https://huggingface.co/blog/feed.xml | Primary project/vendor announcements; Hugging Face Blog |
| `lemonade_releases` | `rss` / RSS/Atom date or updated | https://github.com/lemonade-sdk/lemonade/releases.atom | Primary project/vendor announcements; Lemonade Releases |
| `rocm_therock_releases` | `rss` / RSS/Atom date or updated | https://github.com/ROCm/TheRock/releases.atom | Primary project/vendor announcements; ROCm TheRock Releases |
| `llamacpp_releases` | `rss` / RSS/Atom date or updated | https://github.com/ggml-org/llama.cpp/releases.atom | Primary project/vendor announcements; llama.cpp Releases |
| `vllm_releases` | `rss` / RSS/Atom date or updated | https://github.com/vllm-project/vllm/releases.atom | Primary project/vendor announcements; vLLM Releases |
| `ollama_releases` | `rss` / RSS/Atom date or updated | https://github.com/ollama/ollama/releases.atom | Primary project/vendor announcements; Ollama Releases |
| `mlx_releases` | `rss` / RSS/Atom date or updated | https://github.com/ml-explore/mlx/releases.atom | Primary project/vendor announcements; Apple MLX Releases |
| `dotnet_blog` | `rss` / RSS/Atom date or updated | https://devblogs.microsoft.com/dotnet/feed/ | Primary project/vendor announcements; Microsoft .NET Blog |
| `visualstudio_blog` | `rss` / RSS/Atom date or updated | https://devblogs.microsoft.com/visualstudio/feed/ | Primary project/vendor announcements; Microsoft Visual Studio Blog |
| `arm_newsroom` | `rss` / RSS/Atom date or updated | https://newsroom.arm.com/feed | Primary project/vendor announcements; Arm Newsroom |
| `omarchy_news` | `rss` / RSS/Atom date or updated | https://omarchy.org/news/rss.xml | Primary project/vendor announcements; Omarchy News |
| `milford_local` | `rss` / RSS/Atom date or updated | https://milfordtownship.org/feed/ | Official local notices; Milford Township |
| `buckslib_local` | `rss` / RSS/Atom date or updated | https://buckslib.org/feed/ | Official local notices; library |
| `verge_news` | `rss` / RSS/Atom date or updated | https://www.theverge.com/rss/index.xml | Independent reporting; technology |
| `mit_tech_review` | `rss` / RSS/Atom date or updated | https://www.technologyreview.com/feed/ | Independent reporting; technology |
| `bluesky_simon_willison` | `bluesky` / Author post createdAt | https://bsky.app/profile/simonwillison.net — `did:plc:kft6lu4trxowqmter2b6vg6z` | Author/community discovery; pinned original-post identity |
| `bluesky_ars_technica` | `bluesky` / Author post createdAt | https://bsky.app/profile/arstechnica.com — `did:plc:wld6fad6xsm4tz4kfkoikun2` | Author/community discovery; pinned original-post identity |
| `bluesky_the_register` | `bluesky` / Author post createdAt | https://bsky.app/profile/theregister.com — `did:plc:bz67dxqh5nmjl5it36xylqyy` | Author/community discovery; pinned original-post identity |
| `intel_news` | `rss` / RSS/Atom date or updated | https://www.intc.com/news-events/press-releases/rss | Primary project/vendor announcements; Intel |
| `pytorch_blog` | `rss` / RSS/Atom date or updated | https://pytorch.org/blog/feed/ | Primary project/vendor announcements; PyTorch |
| `claude_code_releases` | `rss` / RSS/Atom date or updated | https://github.com/anthropics/claude-code/releases.atom | Primary project/vendor announcements; Claude Code |
| `servethehome` | `rss` / RSS/Atom date or updated | https://www.servethehome.com/feed/ | Independent reporting; compute/hardware |
| `techpowerup` | `rss` / RSS/Atom date or updated | https://www.techpowerup.com/rss/news | Independent reporting; hardware |
| `the_race_f1` | `rss` / RSS/Atom date or updated | https://www.the-race.com/rss/ | Independent reporting; F1 |
| `bluesky_techcrunch` | `bluesky` / Author post createdAt | https://bsky.app/profile/techcrunch.com — `did:plc:vtpyqvwce4x6gpa5dcizqecy` | Author/community discovery; pinned original-post identity |
| `github_blog` | `rss` / RSS/Atom date or updated | https://github.blog/feed/ | Primary project/vendor announcements; GitHub Blog |
| `google_research` | `rss` / RSS/Atom date or updated | https://research.google/blog/rss/ | Primary project/vendor announcements; Google Research |
| `anthropic_news` | `official_html` / Visible dated HTML | https://www.anthropic.com/news | Primary project/vendor announcements; Anthropic News |
| `anthropic_research` | `official_html` / Visible dated HTML | https://www.anthropic.com/research | Primary project/vendor announcements; Anthropic Research |
| `gaia_releases` | `rss` / RSS/Atom date or updated | https://github.com/amd/gaia/releases.atom | Primary project/vendor announcements; AMD GAIA Releases |
| `lemonade_merged_prs` | `github_pr` / PR merged_at | https://api.github.com/repos/lemonade-sdk/lemonade/pulls | Primary development activity; merge does not establish release |
| `nvidia_developer_blog` | `rss` / RSS/Atom date or updated | https://developer.nvidia.com/blog/feed/ | Primary project/vendor announcements; NVIDIA Developer Blog |
| `nasa_news` | `rss` / RSS/Atom date or updated | https://www.nasa.gov/feed/ | Primary project/vendor announcements; NASA |
| `deepseek_updates` | `official_html` / Visible dated HTML | https://api-docs.deepseek.com/updates/ | Primary project/vendor announcements; DeepSeek Updates |
| `openclaw_news` | `rss` / RSS/Atom date or updated | https://openclaw.ai/rss.xml | Primary project/vendor announcements; OpenClaw News |
| `jetbrains_blog` | `rss` / RSS/Atom date or updated | https://blog.jetbrains.com/feed/ | Primary project/vendor announcements; JetBrains |
| `infoq_agents` | `rss` / RSS/Atom date or updated | https://feed.infoq.com/Agents/news/ | Curated reporting; substantial agent news |
| `esa_science` | `rss` / RSS/Atom date or updated | https://www.esa.int/rss/science.rss | Primary project/vendor announcements; ESA Space Science |
| `spacenews` | `rss` / RSS/Atom date or updated | https://spacenews.com/feed/ | Independent reporting; space |
| `virgin_galactic_news` | `official_html` / Visible dated HTML | https://www.virgingalactic.com/news | Primary project/vendor announcements; Virgin Galactic |
| `huggingface_posts` | `huggingface_posts` / Post publishedAt | https://huggingface.co/api/posts?skip=0&sort=recent | Community discovery; retain author/post and outbound provenance |
| `pi_announcements` | `rss` / RSS/Atom date or updated | https://earendil.com/posts/feed.atom | Primary project/vendor announcements; Earendil / Pi Announcements |

## Freshness, failures and coverage

- A completed empty traversal is an empty window only when the adapter certifies coverage. A valid empty finite RSS/HTML/HN/HF snapshot still carries its finite-history limitation; it cannot establish no news anywhere.
- `partial` means saved traversal remains unfinished. Cursor movement demonstrates backlog progress; it does not prove the current head was refreshed. Head observation and saved-window coverage must remain separate. HN's observed old snapshot is the freshness defect in #136.
- `gap` with `finite_feed_history`, `finite_index_history` or `finite_top_story_snapshot` records upstream archive limits. Preserve this reason after snapshot exhaustion. Mutable HF offset pages can omit/repeat entries; refreshed-head discovery does not repair historical omissions.
- `malformed_source_dates` is a coverage problem requiring investigation, distinct from routine finite history. Unknown dates do not become fresh by assigning retrieval time. Visible HTML layouts and anonymous JSON schemas can change; parser failure is a source failure.
- HTTP 429 (including ROCm), 403, timeout, body-limit and parser failures remain failures. Preserve the saved cursor and future scheduled opportunities; retry/backoff must stay bounded and must not hide a persistent outage. A successful peer source must continue saving independently.
- `last_success_at` and `covered_through` are successful-coverage state, not universal last-fetch clocks: finite-history gaps and partial scans may persist useful evidence without advancing either. Reconcile attempts (`started_at`, `finished_at`, outcome and fetched count), checkpoint cursor/window, explicit coverage reasons and available head-observation state together. Do not label all sources with null coverage timestamps as transport failures.

The current source set intentionally excludes xAI/Grok after HTTP 403; do not bypass access controls or enable it based on the HTML allowlist alone. Perplexity is absent from the roster. Hermes relies on curated reporting without a direct announcement RSS or completeness guarantee; raw Pi/Hermes/OpenClaw release feeds were deliberately excluded for patch noise. Upper Bucks local coverage remains limited to the configured public notices. Existing topic tables, legacy Reddit/PRAW code and `examples/collector-sources.json` do not establish active Warp Core coverage. No private newsletter intake is part of this inventory.

## Operational and verification handoff

[#165](https://github.com/itomek/itomek-news-digest-agent/issues/165) owns exception reporting: persistent HTTP/parser failures, malformed dates and stale current-head observations need sanitized source IDs/error categories, last observed timestamps, recurrence and recovery state. Routine finite-history limits and advancing partial pages are not transport-outage alerts. Existing optional Gmail notification delivery must not block ingestion or processing. Never include upstream bodies, secrets or private mailbox content in public evidence.

For deployment reconciliation, an authorized operator must read back the exact collector bundle/module contents, roster/configuration, JWT requirement, migrations and active schedules, then collect sanitized `warpcore_source_sync_health` and `warpcore_source_sync_attempts` evidence. Record capture time and distinguish last attempted retrieval, retained evidence, current-head observation and successful coverage. This audit leaves that acceptance item open until evidence exists; it authorizes no deployment.

[#162](https://github.com/itomek/itomek-news-digest-agent/issues/162) owns full claim/date/primary-evidence verification, including release update dates versus actual availability, DeepSeek dated-section identities, PR merge versus shipped release, community outbound attribution and native repost provenance. [#164](https://github.com/itomek/itomek-news-digest-agent/issues/164) owns representative live-source evaluation: successful and empty finite windows, blocked/rate-limited/oversized sources, changed layouts or dates, partial current-head catch-up and independent peer progress. Fixture parsing and the dated checks recorded for #191 do not substitute for that evaluation.
