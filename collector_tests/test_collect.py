import json
import sys
import unittest
from datetime import UTC, datetime
from unittest.mock import patch

import httpx

from news_digest.collect import collect
from news_digest.collector import Fetcher, UnsafeURL, parse_feed

NOW = datetime(2026, 10, 20, 12, tzinfo=UTC)
RSS = b"""<rss><channel><item><title>New model</title><link>https://example.org/model</link><pubDate>Tue, 20 Oct 2026 10:00:00 GMT</pubDate><description>Release</description></item><item><title>Old</title><link>https://example.org/old</link><pubDate>Mon, 19 Oct 2020 10:00:00 GMT</pubDate></item></channel></rss>"""


class CollectorTests(unittest.TestCase):
    def test_import_has_no_application_dependencies(self):
        self.assertNotIn("gaia", sys.modules)
        self.assertNotIn("news_digest.config", sys.modules)
        self.assertNotIn("news_digest.logging", sys.modules)

    def test_feed_dates_and_cutoff(self):
        items = parse_feed(RSS, "https://example.org/feed", NOW, 24)
        self.assertEqual([x["title"] for x in items], ["New model"])

    def test_atom_relative_links(self):
        xml = b'<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>A</title><link href="/a"/><updated>2026-10-20T10:00:00Z</updated></entry></feed>'
        self.assertEqual(
            parse_feed(xml, "https://example.org/feed", NOW, 24)[0]["url"],
            "https://example.org/a",
        )

    def test_redirect_to_private_blocked(self):
        transport = httpx.MockTransport(
            lambda r: httpx.Response(
                302, headers={"location": "http://127.0.0.1/secret"}
            )
        )
        with patch(
            "news_digest.collector.socket.getaddrinfo",
            return_value=[(2, 1, 6, "", ("93.184.216.34", 443))],
        ):
            with Fetcher(transport=transport, delay=0) as fetcher:
                with self.assertRaises(UnsafeURL):
                    fetcher.get("https://example.org/feed")

    def test_size_bound(self):
        with patch(
            "news_digest.collector.socket.getaddrinfo",
            return_value=[(2, 1, 6, "", ("93.184.216.34", 443))],
        ):
            with Fetcher(
                transport=httpx.MockTransport(
                    lambda r: httpx.Response(200, content=b"x" * 100)
                ),
                delay=0,
                max_bytes=10,
            ) as f:
                with self.assertRaises(ValueError):
                    f.get("https://example.org/")

    def test_dedupe_and_explicit_unavailable(self):
        class Fake:
            def get(self, url):
                return RSS

        config = {
            "sources": [
                {"id": "a", "type": "rss", "url": "https://example.org/feed"},
                {"id": "b", "type": "rss", "url": "https://example.org/feed"},
                {"id": "reddit", "type": "reddit"},
            ]
        }
        result = collect(config, Fake(), now=NOW)
        self.assertEqual(len(result["articles"]), 1)
        self.assertEqual(len(result["articles"][0]["provenance"]), 2)
        self.assertEqual(result["sources"][-1]["status"], "unavailable")
        json.dumps(result)

    def test_source_failure_does_not_hide_success(self):
        class Fake:
            def get(self, url):
                if "bad" in url:
                    raise ValueError("blocked")
                return RSS

        result = collect(
            {
                "sources": [
                    {"id": "bad", "type": "rss", "url": "https://bad.example/feed"},
                    {"id": "ok", "type": "rss", "url": "https://example.org/feed"},
                ]
            },
            Fake(),
            now=NOW,
        )
        self.assertEqual(len(result["articles"]), 1)
        self.assertEqual(result["sources"][0]["status"], "error")

    def test_hn_bounded_and_signal_label(self):
        class Fake:
            calls = []

            def get(self, url):
                self.calls.append(url)
                if url.endswith("topstories.json"):
                    return b"[1,2,3]"
                return json.dumps(
                    {
                        "id": 1,
                        "type": "story",
                        "title": "Model",
                        "url": "https://example.org/model",
                        "time": int(NOW.timestamp()),
                        "score": 12,
                        "descendants": 3,
                    }
                ).encode()

        f = Fake()
        result = collect(
            {"sources": [{"id": "hn", "type": "hn", "limit": 1}]}, f, now=NOW
        )
        self.assertEqual(len(f.calls), 2)
        self.assertEqual(result["articles"][0]["evidence"], "community_signal")
        self.assertEqual(result["articles"][0]["signals"]["score"], 12)


class SafetyAndDiscoveryTests(unittest.TestCase):
    def test_all_hn_details_failed_is_error(self):
        class Fake:
            def get(self, url):
                if url.endswith("topstories.json"):
                    return b"[1,2]"
                raise ValueError("unavailable")

        result = collect(
            {"sources": [{"id": "hn", "type": "hn", "limit": 2}]}, Fake(), now=NOW
        )
        self.assertEqual(result["sources"][0]["status"], "error")
        self.assertEqual(result["articles"], [])

    def test_bad_config_rejected(self):
        for config in ([], {"schema_version": 2, "sources": []}, {"sources": []}):
            with self.assertRaises(ValueError):
                collect(config, None, now=NOW)

    def test_dns_private_answer_blocked(self):
        from news_digest.collector import validate_url

        with patch(
            "news_digest.collector.socket.getaddrinfo",
            return_value=[(2, 1, 6, "", ("10.0.0.1", 443))],
        ):
            with self.assertRaises(UnsafeURL):
                validate_url("https://example.org/")

    def test_denial_not_retried(self):
        with patch(
            "news_digest.collector.socket.getaddrinfo",
            return_value=[(2, 1, 6, "", ("93.184.216.34", 443))],
        ):
            with Fetcher(
                transport=httpx.MockTransport(lambda r: httpx.Response(403)), delay=0
            ) as f:
                with self.assertRaises(httpx.HTTPStatusError):
                    f.get("https://example.org/")
                self.assertEqual(f.requests, 1)

    def test_listing_discovery_same_origin_and_robots(self):
        class Fake:
            calls = []

            def get(self, url):
                self.calls.append(url)
                if url.endswith("robots.txt"):
                    return b"User-agent: *\nDisallow: /blocked"
                if url.endswith("/article"):
                    return b"<title>Release</title><article>Public article</article>"
                return b'<title>Index</title><a href="/article">Read</a><a href="/blocked">No</a><a href="https://other.example/">External</a>'

        f = Fake()
        result = collect(
            {
                "sources": [
                    {
                        "id": "site",
                        "type": "html",
                        "url": "https://example.org/",
                        "follow_links": 3,
                    }
                ]
            },
            f,
            now=NOW,
        )
        self.assertEqual(len(result["articles"]), 2)
        self.assertEqual(len(f.calls), 3)
        self.assertEqual(result["sources"][0]["status"], "partial")
        self.assertEqual(result["articles"][0]["date_status"], "unknown")

    def test_robots_failure_preserves_listing(self):
        class Fake:
            def get(self, url):
                if url.endswith("robots.txt"):
                    raise ValueError("unavailable")
                return b'<title>Index</title><a href="/article">Read</a>'

        result = collect(
            {
                "sources": [
                    {
                        "id": "site",
                        "type": "html",
                        "url": "https://example.org/",
                        "follow_links": 1,
                    }
                ]
            },
            Fake(),
            now=NOW,
        )
        self.assertEqual(len(result["articles"]), 1)
        self.assertEqual(result["sources"][0]["status"], "partial")

    def test_dtd_rejected(self):
        with self.assertRaises(ValueError):
            parse_feed(b"<!DOCTYPE rss><rss/>", "https://example.org/", NOW, 24)


class FixedSourceTests(unittest.TestCase):
    def test_fixed_mode_only_pinned_hosts_without_dns(self):
        with patch(
            "news_digest.collector.socket.getaddrinfo",
            side_effect=AssertionError("local DNS not allowed"),
        ):
            with Fetcher(
                transport=httpx.MockTransport(
                    lambda r: httpx.Response(200, content=b"ok")
                ),
                delay=0,
                fixed_public_sources=True,
            ) as f:
                self.assertEqual(f.get("https://lemonade-server.ai/"), b"ok")
                for url in (
                    "https://example.org/",
                    "http://lemonade-server.ai/",
                    "https://lemonade-server.ai:444/",
                    "https://127.0.0.1/",
                    "https://lemonade-server.ai.evil.test/",
                    "https://user@lemonade-server.ai/",
                ):
                    with self.assertRaises(UnsafeURL):
                        f.get(url)

    def test_fixed_mode_rejects_even_same_host_redirect(self):
        with Fetcher(
            transport=httpx.MockTransport(
                lambda r: httpx.Response(302, headers={"location": "/next"})
            ),
            delay=0,
            fixed_public_sources=True,
        ) as f:
            with self.assertRaises(UnsafeURL):
                f.get("https://lemonade-server.ai/")
            self.assertEqual(f.requests, 1)


if __name__ == "__main__":
    unittest.main()
