"""Scheduler for the News Digest Agent.

Wraps APScheduler to trigger agent.process_query() on configured intervals.
Designed to run as a long-lived daemon via systemd.
"""

# TODO: Phase 2 implementation
#
# import os
# import logging
# from apscheduler.schedulers.blocking import BlockingScheduler
# from dotenv import load_dotenv
#
# load_dotenv()
#
# logger = logging.getLogger(__name__)
#
# DAILY_HOUR = int(os.getenv("SCHEDULE_DAILY_HOUR", "5"))
# DAILY_MINUTE = int(os.getenv("SCHEDULE_DAILY_MINUTE", "0"))
# WEEKLY_DAY = os.getenv("SCHEDULE_WEEKLY_DAY", "sun")
# WEEKLY_HOUR = int(os.getenv("SCHEDULE_WEEKLY_HOUR", "22"))
# WEEKLY_MINUTE = int(os.getenv("SCHEDULE_WEEKLY_MINUTE", "0"))
#
#
# def run_due_topics():
#     """Check which topics are due and run the agent for each."""
#     from news_digest.agent import NewsDigestAgent
#
#     agent = NewsDigestAgent(
#         supabase_url=os.environ["SUPABASE_URL"],
#         supabase_key=os.environ["SUPABASE_SERVICE_KEY"],
#         model_id=os.getenv("AGENT_MODEL_ID", "Qwen3.5-35B-A3B-GGUF"),
#     )
#
#     # TODO: Query digest_topics for enabled topics, check cadence vs last run,
#     # and call agent.process_query() for each due topic.
#     logger.info("Checking for due topics...")
#
#
# def main():
#     """Entry point for the scheduler daemon."""
#     scheduler = BlockingScheduler()
#
#     # Daily topics (AI models, AI updates)
#     scheduler.add_job(
#         run_due_topics,
#         "cron",
#         hour=DAILY_HOUR,
#         minute=DAILY_MINUTE,
#         id="daily_digest",
#     )
#
#     # Weekly topics (local news, Penguins)
#     scheduler.add_job(
#         run_due_topics,
#         "cron",
#         day_of_week=WEEKLY_DAY,
#         hour=WEEKLY_HOUR,
#         minute=WEEKLY_MINUTE,
#         id="weekly_digest",
#     )
#
#     logger.info(
#         "News Digest scheduler started. "
#         f"Daily at {DAILY_HOUR:02d}:{DAILY_MINUTE:02d}, "
#         f"Weekly on {WEEKLY_DAY} at {WEEKLY_HOUR:02d}:{WEEKLY_MINUTE:02d}"
#     )
#     scheduler.start()
#
#
# if __name__ == "__main__":
#     main()
