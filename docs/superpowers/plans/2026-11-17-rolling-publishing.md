# Rolling news publication

The owner requests a simpler publish-as-news-is-verified flow. This supersedes the previous requirement to finish and globally rank the entire fixed scan before publishing any story. Every captured candidate still receives review; completion records coverage without sorting or creating a final top-five shortlist.

1. Capture up to ten existing pages per bounded invocation, continuing normally when more remain. No total/source quota or omitted tail.
2. Make committed eligible decisions available to verification before full review completion. Interleave verification and remaining review fairly; respect the shared five-item queue bound before new paid verification. Preserve evidence, history, receipt, lease, budget and unknown-outcome guards.
3. Remove the separate five-items-per-parent-run gates; retain five pending items and five publication attempts per account/hour.
4. Use one recurring pipeline tick for collection/review and durable queue recovery. Agent inbox insertion immediately dispatches the existing curator, and an approved prepared record immediately dispatches the existing publisher. Coalesce requests by stage to avoid duplicate authentication; remove the four old stage schedules after cutover. Check for actual queued work before authentication. Raise only the self-imposed login guard to five atomic attempts/account/UTC-hour, keeping failed attempts consumed and all existing records. Keep the live publisher enable flag and pinned account.
5. Remove the obsolete active sort/shortlist creation and separate stage schedules, preserving historical audits and durable queues.
6. Use focused early-post/fairness/full-coverage/login/empty-queue/concurrency regressions and existing CI, then deploy with exact read-back. No model carousel or expanded editorial-quality campaign.

Ownership: SQL/runtime interleaving and its tests belong to rank_sql; publisher queue/auth/login guard and its tests belong to rank_contract. Single-pipeline dispatch SQL/tests belong to agent_schedule. The parent owns deployment, schedules, documentation and release judgment. Changes share one isolated checkout and must preserve each other's work.
