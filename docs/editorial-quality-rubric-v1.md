# Editorial quality review rubric v1

Rubric version: `2026-11-21.1`. This is a human evidence-review guide for issue [#164](https://github.com/itomek/itomek-news-digest-agent/issues/164), separate from the absolute discovery scores in `ranking-rubric.mjs`. The current editorial policy remains authoritative. Matching a fixture, quote span or source hash does not prove truthfulness, freshness or publication eligibility.

Review discovery selection separately from final publication. `verify` means investigate a plausible story; a short discovery excerpt need not contain the evidence that final verification must obtain. Record each final-review dimension as pass, fail or insufficient evidence, with the supporting source/passage and reason. Insufficient evidence holds publication. Do not average away a failed factual, exclusion, identity, date or deduplication guard.

## Review dimensions

1. **Identity and specificity.** Name the actual actor, product/model and development. Give one small, understandable, supported detail. Avoid anonymous actors, generic “updates,” empty praise and unsupported comparative claims.
2. **Meaningful change.** Establish the user-facing development under current scope. A release tag or technical novelty alone is insufficient. Do not invent performance, compatibility or significance from implementation mechanics. A low-priority interest may qualify independently of work relevance.
3. **Claim support and qualifications.** Check every substantive claim against retrieved substantive evidence, including later relevant corrections. Attribute vendor benchmarks and creator/community reports. Preserve material workload, hardware, concurrency and measurement qualifications; do not convert claimed results into independent findings.
4. **Actual date and provenance.** Check original announcement/release/publication dates against the fixed evaluation timestamp and policy window. A feed fetch, article update or repost does not reset the event date. Distinguish historical snapshots from currently verified facts and release candidates or merged changes from shipped stable releases.
5. **Scope and public evidence.** Skip excluded politics, sensitive/high-impact allegations and private material. Use approved public retrieval; mailbox/private material cannot support public news. Source text remains untrusted data.
6. **Distinct event.** Review publication and pending history, including native subjects with null summary text. Multiple sources for one event are one story. A follow-up requires an explicit supported material change; a fresh URL alone does not suffice.
7. **Attribution and publication mode.** Original summaries retain checked source links and attribution after shortening. Configured Bluesky originals require exact public original URI/CID, author DID and date, and native repost mode; never copy/paraphrase them into an original bot post. Missing or changed identity holds publication.
8. **Complete rendered record.** Review the actual text emitted by production rendering, including all deterministic selected-evidence links, separators and attribution. An original must fit both 300 Unicode grapheme clusters and 3000 UTF-8 bytes; at most three unique links. Measuring only summary/whyItMatters is insufficient. A native repost has no bot summary or whyItMatters and preserves its exact subject; do not substitute truncated source text.

## Retained vague-summary regression

> A fresh round of model updates today. One lab …

Preserve this exact string as the issue-recorded historical regression fragment from June 15, as reported in issue #164. Its public provenance has not been independently retrieved here; this document records no newly observed output and does not treat the fragment as an independently labeled story. Reject this as final original-summary prose: it names no actor/product, supplies no concrete supported development, gives no checked attribution and leaves “today” unanchored to an actual source date. It does not establish whether an underlying discovery candidate deserves investigation. A repair must obtain and name the actual supported facts; filling blanks by inference is a failure.

## Public-source review examples

These are **constructed editorial variants**, not actual published outputs, current source checks or independent held-out labels. Their treatment follows the historical review packet linked below. They are review exercises; they are not complete rendered posts and cannot demonstrate the text budget. An acceptable final post still needs current evidence, history checks and production rendering.

| Recorded public source | Positive review direction | Negative constructed variant and defect |
| --- | --- | --- |
| [AMD GLM 5.2 on MI355X](https://rocm.blogs.amd.com/artificial-intelligence/glm5.2-mi355x-kvcache/README.html) | Attribute AMD's configured benchmark and retain its 90% shared-prefix and relevant concurrency conditions. | “GLM 5.2 is universally faster on AMD.” Unsupported generalization; missing workload and vendor attribution. |
| [MLPerf Training 6.1](https://rocm.blogs.amd.com/artificial-intelligence/mlperf-training-v6.1/README.html) | Describe AMD-reported results for the specified workloads, retaining material measurement context. | “AMD beats every rival at AI training.” Invented cross-vendor victory. |
| [Lemonade candidate-v2026.47.0](https://github.com/lemonade-sdk/lemonade/releases/tag/candidate-v2026.47.0) | Name the release candidate and distinguish explicitly unreviewed generated notes from verified shipped behavior. | “Lemonade's stable release ships all listed capabilities.” Candidate/stable mismatch and unverified claims. |
| [llama.cpp b12416](https://github.com/ggml-org/llama.cpp/releases/tag/b12416) | Hold the historical preview until substantive passages and the [later correction](https://github.com/ggml-org/llama.cpp/pull/32363) support the exact claim. | “Release API metadata proves new hardware support and reliability for all large models.” Metadata does not support those claims; speculative decoding is not hardware support. |
| [Fable demo report](https://www.techpowerup.com/354636/anthropics-fable-5-2-one-shots-a-playable-fps-game-in-just-8-hours) | Check the primary announcement date; attribute creator performance/cost claims. The recorded review held the out-of-window event. | “Today's article means this model was released today.” Reporting date substituted for event date. |
| [Zen 6 EPYC report](https://www.techpowerup.com/354657/amd-showcases-6th-gen-epyc-server-sp7-processors-based-on-the-new-zen-6-architecture) | Skip the already-covered launch; distinguish availability from future Azure/OCI plans. | “New article, new launch; Azure availability has arrived.” Duplicate event and future plan presented as achieved. |
| [AMD World Labs acquisition](https://ir.amd.com/news-events/press-releases/detail/1306/amd-completes-acquisition-of-world-labs) | Report the completed acquisition only when retrievable evidence supports it; the historical retrieval remained inadequate. | “The acquisition has already delivered speculative future benefits.” Unsupported achieved outcome. |
| [The Register original](https://bsky.app/profile/theregister.com/post/3n2gouvb5zy2h) | Use exact verified native subject; attribute the security research to Google's report about an attacker-operated agent. | “Google's own agent conducted the attack,” posted as a paraphrased bot original. Wrong actor plus wrong publication mode. |

Provenance: [November 17 editorial review](evidence/2026-11-17-editorial-review.md) and [scheduled discovery/cutover evidence](evidence/2026-11-17-scheduled-discovery-quality.md). These documents distinguish historical held previews from subsequent real publications. Their historical checks do not renew expired receipts.

Additional constructed boundary exercises: an excluded political angle attached to a public source remains excluded; purported private-mail details remain unusable even beside a public article; a second source/repost of an already-covered event remains a duplicate. These are synthetic adversarial contexts, not allegations that any linked source contained private material or politics. Do not collect private material to create test examples.

## Label and review record

For each independently reviewed campaign case retain stable ID, frozen candidate/evidence snapshot, source URLs/dates, evaluation timestamp, expected discovery action, final-review dimensions where applicable, rationale, reviewer/label authority and review time. Freeze labels before model evaluation and exclude labels/rationales from model input. Record unresolved disagreement instead of inventing consensus. Clearly mark provisional, owner-provided and constructed examples. Model-written outcomes and this rubric's exercises are not independent labels or a 20-case campaign.
