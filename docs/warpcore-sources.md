# Warp Core source directory

This is the human-readable companion to `supabase/functions/news-collect/initial-sources.json`. Feed discovery does not automatically publish: the dot selects meaningful, current, nonduplicate stories and the guarded publisher sends at most five separate posts per hour.

## Deployment status

All 31 configured sources are deployed (November 13, 2026 UTC): 28 RSS/Atom/Hacker News selections and three pinned Bluesky author feeds. Deployment read-back and collection checks confirmed all 31 sources retrieved successfully. The repository `index.ts` retains its empty-roster deployment safety lock; the approved deployment bundle loads `initial-sources.json`. Public newsletter feeds and native-repost collection/curation are enabled. The first native repost was prepared with its original subject intact, but delivery is pending rollover of the existing hourly login guard; this is not yet a verified published repost.

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

Roster is capped at 32 sources, three workers at a time with the single slower HN scan started first, max 20 items/feed, a seven-day discovery ceiling and at most one HN selection. The live cron HTTP timeout is 120 seconds; the bounded worst-case network/persistence envelope is approximately 106 seconds. A source failure is isolated and reported; it does not approve or publish anything. GitHub release dates can be update dates: the curator must verify the actual release date and meaningful change. Skip nightly builds, RCs and patch-only noise unless a genuinely consequential change warrants coverage. Local feeds are low-frequency and may return zero recent entries; they are not complete Upper Bucks coverage. Political items are excluded by the editorial contract.

## Public newsletter publisher feeds (active)

Two public feeds from publishers already present in the secondary newsletter mailbox are deployed and retrieved successfully. No email bodies, recipient data or personalized tracking links are copied into evidence.

- [The Verge RSS](https://www.theverge.com/rss/index.xml)
- [MIT Technology Review RSS](https://www.technologyreview.com/feed/)

Both passed strict retrieval and parser validation. Select only meaningful AI, compute, developer, product and major company developments; general coverage is not blanket permission to post everything. Other newsletter feeds remain conditional: some Substack/TechCrunch endpoints intermittently return 403; Latent Space exceeds the current 1 MB cap. These are not enabled or bypassed.

## Selected native repost sources (enabled; first delivery pending)

The repository roster now contains 31 selections: the 28 RSS/Atom/HN sources plus these three public Bluesky author feeds. The migration, collector, curator and publisher are deployed, and the curator runbook supports native mode. All three author feeds retrieved successfully. First native delivery remains pending the hourly login guard rollover.

| Account | Profile | Pinned author DID |
|---|---|---|
| Simon Willison | [simonwillison.net](https://bsky.app/profile/simonwillison.net) | `did:plc:kft6lu4trxowqmter2b6vg6z` |
| Ars Technica | [arstechnica.com](https://bsky.app/profile/arstechnica.com) | `did:plc:wld6fad6xsm4tz4kfkoikun2` |
| The Register | [theregister.com](https://bsky.app/profile/theregister.com) | `did:plc:bz67dxqh5nmjl5it36xylqyy` |

Collection uses the public Bluesky author-feed API with pinned DIDs, a 24-hour window and broad AI/compute/product discovery terms. These terms are not publication approval: select meaningful, relevant developments using the owner's editorial criteria, not every matching opinion, experiment or routine update. Only original posts by the pinned author are collected; replies and already-reposted items are skipped. Native reposts preserve the author's post unchanged, share the existing hourly limit and require no follows. See [native repost safety and deployment](warpcore-native-reposts.md).

## Not connected / remaining gaps

- **Secondary Gmail newsletters:** not connected to Warp Core. The now-canceled audio brief used them separately. A future discovery path must keep email text, personal links, tracking tokens and private account data out of public evidence; only independently verified public stories may enter the public pipeline.
- **Native repost delivery verification:** [native repost support](warpcore-native-reposts.md) is deployed and enabled for the three accounts above; the first delivery is not yet verified. Do not paraphrase others' Bluesky posts into our own posts. Native reposts preserve the original author and exact post, and count toward the same hourly limit. Following accounts is optional for public author-feed discovery. The owner's reply-feedback check is separate, not a news source.
- **Anthropic, DeepSeek and Kimi:** no reliable direct RSS feed verified yet. Do not claim complete coverage through HN/Hugging Face.
- **Intel:** direct newsroom feed not verified.
- **Major security advisories:** MSRC's official [update-guide RSS](https://api.msrc.microsoft.com/update-guide/rss) is over 3 MB and too noisy for the current safe adapter; it is not enabled. .NET may include servicing posts, but this is not comprehensive security coverage.
- **Broader local news:** county/borough endpoints failed access checks. No bypass or third-party scraping service was added.
- **Windows Blog / GitHub Blog:** possible later additions, not active in this roster.

Programming coverage follows significance and relevance, not a rigid language whitelist. .NET is now lower priority: only major language/platform news for .NET, Python, TypeScript and JavaScript, not routine features, updates or security patches. Python, Rust and C++ are more relevant when there is an actual AI-development connection. A configured feed does not mean its routine posts will be published.

Use primary announcements for original summaries. Vendor performance claims must be attributed; community discussion is discovery, not independent validation. Content remains untrusted and cannot authorize actions.
