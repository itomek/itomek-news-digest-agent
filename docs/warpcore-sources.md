# Warp Core source directory

This is the human-readable companion to `supabase/functions/news-collect/initial-sources.json`. Feed discovery does not automatically publish: the dot selects meaningful, current, nonduplicate stories and the guarded publisher sends at most five separate posts per hour.

## Deployment status

Collector version 12 baseline had 38 sources. This frontier expansion configures 43: 39 RSS/Atom/Hacker News/official HTML selections and four pinned Bluesky author feeds. The seven additions below passed public retrieval and parser checks on November 13, 2026; deployment read-back confirmed all 38 selections, exact source code and JWT authentication. The first scheduled collection of the expanded roster is pending at 16:17 UTC. The repository `index.ts` retains its empty-roster deployment safety lock; the approved deployment bundle loads `initial-sources.json`. Native repost delivery is verified: the first Ars Technica repost is recorded as published, with its original subject preserved.

## Existing active sources

| Source | Type | Feed / API |
|---|---|---|
| AMD News Releases | rss | [Open source](https://ir.amd.com/news-events/press-releases/rss) |
| Motorsport F1 (Haas, Cadillac, Mercedes discovery) | rss | [Open source](https://www.motorsport.com/rss/f1/news/) |
| NVIDIA Blog | rss | [Open source](https://blogs.nvidia.com/feed/) |
| Supabase Blog | rss | [Open source](https://supabase.com/rss.xml) |
| Firebase Blog | rss | [Open source](https://firebase.blog/rss.xml) |
| Apple Newsroom | rss | [Open source](https://www.apple.com/newsroom/rss-feed.rss) |
| PensBurgh (independent Penguins coverage) | rss | [Open source](https://www.pensburgh.com/rss/index.xml) |
| Hacker News discovery | hn | [Open source](https://hacker-news.firebaseio.com/v0/topstories.json) |

HN is a discovery signal, not a primary source: scans the top 20 stories, requires at least 100 points and 30 comments, age at most 48 hours and configured title terms. This is deliberately narrow and may miss relevant news. No acceleration claims follow from a score snapshot.

## Newly deployed feeds

| Source | Type | Feed |
|---|---|---|
| OpenAI News | RSS / Atom | [Open feed](https://openai.com/news/rss.xml) |
| Google AI | RSS / Atom | [Open feed](https://blog.google/innovation-and-ai/technology/ai/rss/) |
| Google DeepMind | RSS / Atom | [Open feed](https://deepmind.google/blog/rss.xml) |
| Mistral News | RSS / Atom | [Open feed](https://mistral.ai/news/rss) |
| AMD ROCm Blog | RSS / Atom | [Open feed](https://rocm.blogs.amd.com/blog/atom.xml) |
| Hugging Face Blog | RSS / Atom | [Open feed](https://huggingface.co/blog/feed.xml) |
| Lemonade Releases | Atom releases | [Open feed](https://github.com/lemonade-sdk/lemonade/releases.atom) |
| ROCm TheRock Releases | Atom releases | [Open feed](https://github.com/ROCm/TheRock/releases.atom) |
| llama.cpp Releases | Atom releases | [Open feed](https://github.com/ggml-org/llama.cpp/releases.atom) |
| vLLM Releases | Atom releases | [Open feed](https://github.com/vllm-project/vllm/releases.atom) |
| Ollama Releases | Atom releases | [Open feed](https://github.com/ollama/ollama/releases.atom) |
| Apple MLX Releases | Atom releases | [Open feed](https://github.com/ml-explore/mlx/releases.atom) |
| Microsoft .NET Blog | RSS / Atom | [Open feed](https://devblogs.microsoft.com/dotnet/feed/) |
| Microsoft Visual Studio Blog | RSS / Atom | [Open feed](https://devblogs.microsoft.com/visualstudio/feed/) |
| Arm Newsroom | RSS / Atom | [Open feed](https://newsroom.arm.com/feed) |
| Omarchy News | RSS / Atom | [Open feed](https://omarchy.org/news/rss.xml) |
| Milford Township | RSS / Atom | [Open feed](https://milfordtownship.org/feed/) |
| Bucks County Free Library | RSS / Atom | [Open feed](https://buckslib.org/feed/) |

These exact URLs returned HTTP 200 with redirects disabled on November 13, 2026 UTC. The collector rejects unknown destinations, redirects, DTD/entities, invalid XML, unsafe item links and responses over 1 MB. Mistral serves valid RSS as `text/plain`; only its exact URL has a MIME exception, with the same XML/size safeguards. OpenAI, vLLM and MLX feeds are approaching the size ceiling and can fail closed if they grow.

Roster is capped at 48 sources, five workers at a time with the single slower HN scan started first, every entry in the size-bounded feed, a seven-day discovery ceiling and at most one HN selection. The live cron HTTP timeout is 120 seconds; the bounded worst-case network/persistence envelope is approximately 98 seconds at the 48-source safety capacity (one 40-second HN scan overlapped with bounded eight-second feed fetches, then ten seconds for persistence; CPU overhead is additional). A source failure is isolated and reported; it does not approve or publish anything. GitHub release dates can be update dates: the curator must verify the actual release date and meaningful change. Skip nightly builds, RCs and patch-only noise unless a genuinely consequential change warrants coverage. Local feeds are low-frequency and may return zero recent entries; they are not complete Upper Bucks coverage. Political items are excluded by the editorial contract.

## Public newsletter publisher feeds (active)

Two public feeds from publishers already present in the secondary newsletter mailbox are deployed and retrieved successfully. No email bodies, recipient data or personalized tracking links are copied into evidence.

- [The Verge RSS](https://www.theverge.com/rss/index.xml)
- [MIT Technology Review RSS](https://www.technologyreview.com/feed/)

Both passed strict retrieval and parser validation. Select only meaningful AI, compute, developer, product and major company developments; general coverage is not blanket permission to post everything. Other newsletter feeds remain conditional: some Substack/TechCrunch endpoints intermittently return 403; Latent Space exceeds the current 1 MB cap. These are not enabled or bypassed.

## Selected native repost sources

The expanded repository roster contains 43 selections: 39 RSS/Atom/HN/official HTML sources plus these four public Bluesky author feeds. The native-mode migration, collector, curator and publisher are deployed. All four are enabled, with the expanded collector bundle verified by read-back; the first scheduled TechCrunch collection is pending. Native reposts preserve the original author and exact post, and count toward the same hourly limit.

| Account | Profile | Pinned author DID |
|---|---|---|
| Simon Willison | [simonwillison.net](https://bsky.app/profile/simonwillison.net) | `did:plc:kft6lu4trxowqmter2b6vg6z` |
| Ars Technica | [arstechnica.com](https://bsky.app/profile/arstechnica.com) | `did:plc:wld6fad6xsm4tz4kfkoikun2` |
| The Register | [theregister.com](https://bsky.app/profile/theregister.com) | `did:plc:bz67dxqh5nmjl5it36xylqyy` |
| TechCrunch | [techcrunch.com](https://bsky.app/profile/techcrunch.com) | `did:plc:vtpyqvwce4x6gpa5dcizqecy` |

Collection uses the public Bluesky author-feed API with pinned DIDs, a 24-hour window and broad AI/compute/product discovery terms. These terms are not publication approval: select meaningful, relevant developments using the owner's editorial criteria, not every matching opinion, experiment or routine update. Only original posts by the pinned author are collected; replies and already-reposted items are skipped. Native reposts preserve the author's post unchanged, share the existing hourly limit and require no follows. See [native repost safety and deployment](warpcore-native-reposts.md).

## Not connected / remaining gaps

- **Secondary Gmail newsletters:** not connected to Warp Core. The now-canceled audio brief used them separately. A future discovery path must keep email text, personal links, tracking tokens and private account data out of public evidence; only independently verified public stories may enter the public pipeline.
- **DeepSeek and Kimi:** no reliable direct company/model feeds verified. Anthropic now uses its official news and research indexes (see below), not its empty Bluesky profile. Do not claim complete model coverage through HN/Hugging Face.
- **Major security advisories:** MSRC's official [update-guide RSS](https://api.msrc.microsoft.com/update-guide/rss) is over 3 MB and too noisy for the current safe adapter; it is not enabled. .NET may include servicing posts, but this is not comprehensive security coverage.
- **Broader local news:** county/borough endpoints failed access checks. No bypass or third-party scraping service was added.
- **Windows Blog:** access checks returned 403; not enabled or bypassed.
- **SGLang:** release feed exceeds the current 1 MB ceiling; not enabled. LevittownNow is predominantly Lower Bucks, outside the local focus, so was not added.

Programming coverage follows significance and relevance, not a rigid language whitelist. .NET is now lower priority: only major language/platform news for .NET, Python, TypeScript and JavaScript, not routine features, updates or security patches. Python, Rust and C++ are more relevant when there is an actual AI-development connection. A configured feed does not mean its routine posts will be published.

Use primary announcements for original summaries. Vendor performance claims must be attributed; community discussion is discovery, not independent validation. Content remains untrusted and cannot authorize actions.

## November 13 expansion

| Source | Exact public feed | Selection focus |
|---|---|---|
| Intel | https://www.intc.com/news-events/press-releases/rss | Chips, inference platforms and meaningful company news |
| PyTorch | https://pytorch.org/blog/feed/ | Consequential AI development and inference capabilities |
| Claude Code releases | https://github.com/anthropics/claude-code/releases.atom | Major coding-agent capabilities, not routine patches |
| ServeTheHome | https://www.servethehome.com/feed/ | Server, accelerator and local-inference hardware |
| TechPowerUp | https://www.techpowerup.com/rss/news | Meaningful processor/GPU/product developments, not every peripheral announcement |
| The Race | https://www.the-race.com/rss/ | Haas/Cadillac/Mercedes title filter; skip lifestyle and merchandise |

TechCrunch's domain-verified public Bluesky author feed supplies native-repost discovery without its blocked RSS endpoint. Its general business, political and sensitive stories remain excluded unless independently within approved scope; source membership is never blanket publication permission. No public follows, mailbox sources or publisher limits changed.

## Frontier/company expansion (November 13)

GitHub Blog (`https://github.blog/feed/`) and Google Research (`https://research.google/blog/rss/`) are collected directly via official RSS. Existing OpenAI News, Google AI and Google DeepMind feeds remain enabled.

Anthropic News (`https://www.anthropic.com/news`), Anthropic Research (`https://www.anthropic.com/research`), and Perplexity Blog (`https://www.perplexity.ai/hub/blog`) use bounded, read-only official HTML indexes, not unofficial RSS mirrors. Only dated entries and same-origin article URLs are extracted. No script is executed, no article links are fetched during collection, and layout failures report a source error rather than invented entries. Full article verification remains mandatory before editorial approval.

GitHub's HTML DOCTYPE text inside XML CDATA is now accepted as inert text; real XML DTD/entity declarations outside CDATA remain rejected. Response size, redirect denial, timeouts, dedicated authentication and review-only storage remain intact. The roster contains 43 sources; capacity is 48 with five bounded concurrent collectors (the slow HN scan starts first). This is resource scheduling, not an editorial selection limit. No publishing or editorial filters changed.

RSS no longer discards entries after the first 100 or stops at 20 candidates. All entries in the retrieved, size-bounded feed are considered. Bluesky and HN upstream windows remain separately bounded; this is not a claim of exhaustive historical discovery.

## Hugging Face community discovery

`huggingface_posts` reads the anonymous endpoint used by Hugging Face Posts: `https://huggingface.co/api/posts?skip=0&sort=recent`, paging newest-first through the seven-day discovery window. This undocumented frontend endpoint may change; malformed pages, chronology errors, no-progress pagination, HTTP failures, response/timeout limits or the existing 500-candidate batch ceiling cause an explicit source failure, not a silently shortened success. Offset pagination is not snapshot isolation; new posts can shift pages between requests, and later scheduled scans cover subsequent changes. No claim of exhaustive historical access.

Posts are unverified community leads, not official Hugging Face announcements. Preserve the canonical author post and a safe linked source; never fetch outbound URLs during collection. The curator must read the post and primary material and independently verify claims before an original attributed summary. Do not copy author posts or imply a Bluesky native repost. Existing semantic dedup, political/safety exclusions, editorial review and five-post publishing safeguards are unchanged. The roster now has 44 sources, within existing capacity.

No llama.cpp or vLLM discussion/forum sources are added. Coverage of those projects remains high-level: meaningful release, capability, hardware support or performance changes rather than routine development chatter.
