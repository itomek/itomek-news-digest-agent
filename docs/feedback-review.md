# Feedback Review Workflow

Weekly process for querying digest feedback and proposing prompt improvements.
Human-in-the-loop only — no automated prompt regeneration.

## Query

Run this against the `system_logs` table to pull all feedback since the last review:

```sql
select
  id,
  created_at,
  topic_slug,
  metadata->>'feedback_type'   as feedback_type,
  metadata->>'digest_id'       as digest_id,
  metadata->>'prompt_version'  as prompt_version,
  metadata->>'digest_date'     as digest_date,
  metadata->>'comment_text'    as comment_text,
  metadata->>'source_url'      as source_url,
  metadata->>'item_index'      as item_index,
  metadata->>'item_headline'   as item_headline
from system_logs
where category = 'feedback'
  and created_at > :last_review_timestamp
order by created_at desc;
```

Replace `:last_review_timestamp` with the ISO timestamp of the previous review
(e.g. `2026-06-04T00:00:00Z`).

## Feedback types

| `feedback_type`  | Meaning                                    | Key fields                        |
|------------------|--------------------------------------------|-----------------------------------|
| `thumbs_down`    | Digest was not useful                      | `digest_id`, `topic_slug`         |
| `positive`       | Digest was good                            | `digest_id`, `topic_slug`         |
| `comment`        | Free-text note, max 500 chars              | `comment_text`                    |
| `source_flag`    | A source URL was bad / off-topic           | `source_url`                      |
| `item_flag`      | A specific item was bad / irrelevant       | `item_index`, `item_headline`     |

## Cluster by topic

Group the results by `topic_slug` to see which topics attract the most negative
signal. Within each topic, group by `prompt_version` to attribute regressions to
a specific prompt change.

```sql
select
  topic_slug,
  prompt_version,
  feedback_type,
  count(*) as n
from system_logs
where category = 'feedback'
  and created_at > :last_review_timestamp
group by topic_slug, prompt_version, feedback_type
order by topic_slug, n desc;
```

## Review process

1. Run both queries. Export the results to a spreadsheet or paste into a chat.
2. For each topic with net-negative signal (more `thumbs_down`/`item_flag` than `positive`):
   a. Read the `comment_text` entries for that topic.
   b. Review the flagged `item_headline` values — are they off-topic, stale, or low-quality?
   c. Check `source_url` flags — should any source be removed from `digest_topics.sources`?
3. Draft a prompt-diff proposal:
   - A short description of the problem observed.
   - The proposed change to `src/news_digest/prompts.py` or the topic's `prompt_hint`
     in the `digest_topics` Supabase table.
   - Open a PR targeting `main` with the change. Link it to issue #22.
4. After merging, note the new `prompt_version` (derived from the SHA of the updated
   `SYSTEM_PROMPT` in `prompts.py`) and record the review timestamp so the next
   query window starts from here.

## Notes

- `prompt_version` on every feedback row allows regression attribution even if
  multiple prompt versions are in use simultaneously.
- The `authenticated` RLS policy (migration 0012) allows only `category='feedback'`
  inserts from the browser — no other table writes are possible from the web app.
- Do NOT automate prompt regeneration. Every change must be reviewed and approved
  by a human before merging.
