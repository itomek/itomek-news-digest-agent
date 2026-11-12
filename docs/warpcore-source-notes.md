# Deferred topics and source reconnaissance

The owner asked on November 12 to hold off selecting topics. The existing topics remain untouched: AI model releases; AI company/product updates; Formula 1; Bucks County/Quakertown local news; Pittsburgh Penguins; US/Poland world news. These are preserved for later, not enabled as scope for the new publisher.

## Public Bluesky sources checked November 12

These are research candidates, not an activated source roster.

| Account | Evidence | Latest original observed |
|---|---|---|
| [Simon Willison](https://bsky.app/profile/simonwillison.net) | Domain handle and valid profile verification | Nov 10 |
| [Ars Technica](https://bsky.app/profile/arstechnica.com) | Domain handle and valid profile verification | Nov 12 |
| [The Register](https://bsky.app/profile/theregister.com) | Domain handle and valid profile verification | Nov 12 |
| [TechCrunch](https://bsky.app/profile/techcrunch.com) | Domain handle and valid profile verification | Nov 12 |
| [Ai2](https://bsky.app/profile/ai2.bsky.social) | Official allenai.org homepage backlink | Nov 9 |
| [Supabase](https://bsky.app/profile/supabase.com) | Company-domain handle | Apr 8, low-frequency |
| [Firebase](https://bsky.app/profile/firebase.com) | Company-domain handle | No posts |

Evidence was read from public getProfile/getAuthorFeed endpoints. Activity is a snapshot, not a measured trend. Bluesky-only input does not provide complete vendor coverage. The apparent googledeepmind.bsky.social account carries an impersonation label; vllm.bsky.social is unrelated. Do not include either. hf.co is the verified Hugging Face account but had no recent originals observed. Anthropic's domain account was empty.

Ars uses empty post text with external link-card titles/descriptions. The Edge Function now handles those without fetching arbitrary external URLs.

## AMD and selected-team F1 expansion (2026-11-12)

Added AMD's official dated press-release RSS and Motorsport's dated F1 reporting feed after parser validation. AMD remains vendor claims requiring primary context and editorial significance checks. Motorsport is independent reporting, not an official team account. Its discovery filter requires Haas, Cadillac or Mercedes explicitly in the title and rejects common merchandise/lifestyle items; incidental body mentions and driver-only headlines are deliberately held out. This conservative rule can miss relevant stories, and does not establish importance or verify facts. Dot must still assess significance, dates, duplication and primary evidence before approving any post.

Official Formula1 XML currently lacks item dates, so the strict parser yields no candidates; Haas RSS is malformed and includes HTTP links. Neither is enabled. One motorsport outlet avoids overlapping syndicated coverage. Local Quakertown/Upper Bucks source coverage remains incomplete: official county RSS and borough pages returned403 in this validation pass. No access restrictions were bypassed. No publisher, scheduler, credential or approval changes accompany these discovery sources.
