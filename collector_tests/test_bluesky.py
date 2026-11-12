import unittest
from datetime import UTC, datetime

from news_digest.bluesky import collect

NOW = datetime(2026, 11, 12, 12, tzinfo=UTC)


def item(text="New AMD release", date="2026-11-12T10:00:00Z"):
    return {
        "post": {
            "uri": "at://did:plc:abc/app.bsky.feed.post/xyz",
            "author": {"did": "did:plc:abc", "handle": "example.com"},
            "record": {"text": text, "createdAt": date},
        }
    }


class BlueskyTests(unittest.TestCase):
    def test_keeps_recent_matches_and_deduplicates(self):
        result = collect(
            ["example.com"], ["amd"], lambda actor: {"feed": [item(), item()]}, NOW
        )
        self.assertEqual(len(result["candidates"]), 1)
        self.assertEqual(
            result["candidates"][0]["url"],
            "https://bsky.app/profile/did:plc:abc/post/xyz",
        )
        self.assertFalse(result["publishing_enabled"])

    def test_skips_old_future_unknown_unrelated_reply_and_repost(self):
        reply = item()
        reply["post"]["record"]["reply"] = {}
        repost = item()
        repost["reason"] = {"$type": "app.bsky.feed.defs#reasonRepost"}
        rows = [
            item(date="2026-11-10T00:00:00Z"),
            item(date="2026-11-13T00:00:00Z"),
            item(date="bad"),
            item(text="sports"),
            reply,
            repost,
        ]
        self.assertEqual(
            collect(["example.com"], ["amd"], lambda _: {"feed": rows}, NOW)[
                "candidates"
            ],
            [],
        )

    def test_source_failure_is_not_empty_success(self):
        def fail(_):
            raise RuntimeError("failure")

        result = collect(["example.com"], ["amd"], fail, NOW)
        self.assertEqual(result["sources"][0]["status"], "error")

    def test_bad_actor_rejected_before_fetch(self):
        for actor in ["https://evil.test", "localhost", "127.0.0.1", "a.com/?x=1", ""]:
            with self.subTest(actor=actor), self.assertRaises(ValueError):
                collect([actor], ["amd"], lambda _: self.fail("network called"), NOW)

    def test_invalid_feed_is_error(self):
        result = collect(["example.com"], ["amd"], lambda _: {"feed": "bad"}, NOW)
        self.assertEqual(result["sources"][0]["status"], "error")

    def test_seen_uris_skipped(self):
        result = collect(
            ["example.com"],
            ["amd"],
            lambda _: {"feed": [item()]},
            NOW,
            seen={"at://did:plc:abc/app.bsky.feed.post/xyz"},
        )
        self.assertEqual(result["candidates"], [])


class CliTests(unittest.TestCase):
    def test_output_cannot_overwrite_inputs(self):
        import json
        import tempfile
        from pathlib import Path
        from unittest.mock import patch

        from news_digest.bluesky import main

        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.json"
            original = json.dumps({"actors": ["example.com"], "terms": ["amd"]})
            config.write_text(original)
            with (
                patch(
                    "sys.argv",
                    ["bluesky", "--config", str(config), "--output", str(config)],
                ),
                patch(
                    "news_digest.bluesky.collect",
                    return_value={"sources": [{"status": "ok"}]},
                ),
            ):
                self.assertEqual(main(), 2)
            self.assertEqual(config.read_text(), original)
