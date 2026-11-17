# Primary release capture and operations follow-up

This follows merged PR #169 (`9cf9be7`). No production publishing or owner go/no-go is claimed.

## GitHub primary-source capture

Large release HTML pages caused unresolved Cerebras HTTP 400 responses; their billing reservations remain held. The source-size mitigation does not establish the provider error's cause. The public GitHub release API provides a smaller authoritative representation without weakening source proof.

For the seven already-reviewed release repositories, the verifier maps a captured `github.com/<repo>/releases/tag/<tag>` URL to one fixed anonymous `api.github.com/repos/<repo>/releases/tags/<tag>` GET. The original release URL remains the logical source and attribution link. A versioned `github-release-v1` capture records the actual API destination and complete raw JSON; hashes, lossless quote chunks and span checks apply to those actual bytes. There is no truncation, arbitrary crawl, redirect, credential, model-selected host or provider fallback.

Both JavaScript and SQL bind the exact repository/tag, logical URL, API URL, public nondraft release, prerelease flag, and actual `published_at` UTC date. Approval must use that publication date. The 100,000-byte full-capture limit remains. Unsafe decoded NUL/lone-surrogate keys or values are rejected before inference, including metadata outside the release body. Legacy HTML/native captures and historical request bytes remain supported; the verification wire profile stays V4.

A real pinned Deno fetch of Lemonade `candidate-v2026.47.1` captured 34,568 bytes with SHA-256 `c7d155e26f45326f0e5f44cbd0467294ea8d588cb7ac9856a8f64afeca5386dc`; its publication timestamp is `2026-11-16T18:26:46Z`. This is actual acquisition evidence, not a paid hosted verification or published post. The transport supplies GitHub's mandatory fixed application User-Agent only for `api.github.com`; caller-controlled identity/credential headers remain forbidden.

## Exception alerts

The operator selected the existing dashboard channel, with no new external notification service. The first activation attempt rolled back because `refresh_alerts` still compared GPT-oss against an older Groq reservation constant. Alerts stayed disabled and scheduled discovery continued. The correction derives the threshold from the protected active-model helper and requires exact health/model parity. Missing, unknown or mismatched current models fail closed; only an installation with neither runtime settings nor model health uses the explicit legacy fallback.

The deployed News Digest site was reachable at its production URL but required sign-in. Backend projection and authenticated production rendering remain distinct checks; a local mocked rendering result is not real signed-in delivery evidence.

## Verification

519 unit/mock tests, the full embedded SQL suite including the composed API-to-runtime-to-receipt-to-curator path, Deno checking and independent focused review pass. The composed ordinary record reaches the actual 300-grapheme boundary and combined five-story capacity with zero sends. Negative cases cover forged API identity, unsupported repositories/tags, draft/status/date/body/hash/span errors, unsafe JSON and oversized captures. Alert tests cover the actual Cerebras reservation and mismatched/unknown model health.

The targeted SQL upgrades replace only receipt issuance and alert refresh respectively. Their guards require verification/submission disabled and alerts disabled; discovery can continue. Upgrade SHA-256 values: `74130525d70f8289d67c9671bf4db47d5bf1748ab5fe5bead9117887d4cfdeac` and `30b848d8adedd013574fd266d1e54670adb5b4057d9131f209bce3ad9785f68e`.

## Unattended evaluation in progress

The current cloud-only GPT-oss/Cerebras run captured 652 candidates. It uses the existing authenticated minute cron and approved budget; local paid triggers have stopped. Verification/submission stay off while discovery completes.

A separate 16-case diagnostic reference was frozen at `2026-11-17T09:59:01Z` before any of its cases were reviewed. At `09:59:59Z`, durable review had reached 240 candidates and zero reference ordinals had decisions. The private reference SHA-256 is `aae761a5d685d3fda0f9e837dedebb258ad3b77957a43a1ec64a64e2b48fcdbd`. Ten cases have clear binary labels and six are explicitly gray; expected labels never enter model requests. This is prospective diagnostic evidence, not an owner-agreed formal quality campaign or an achieved acceptance percentage.
