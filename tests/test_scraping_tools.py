"""Tests for src/news_digest/tools/scraping.py — issues #5 (fetch_rss) and #6
(fetch_html, parse_article)."""

import hashlib
from collections import Counter
from datetime import UTC, datetime, timedelta
from email.utils import format_datetime
from unittest.mock import MagicMock

import httpx
import pytest

from news_digest.tools import scraping
from news_digest.tools.scraping import _validate_url as _REAL_VALIDATE_URL
from news_digest.tools.scraping import fetch_html, fetch_rss, parse_article

# ---------------------------------------------------------------------------
# Synthetic feed XML helpers
# ---------------------------------------------------------------------------


def _rss(items_xml: str, channel_link: str = "https://example.com") -> str:
    return f"""<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Test Feed</title>
  <link>{channel_link}</link>
  {items_xml}
</channel></rss>"""


def _item(
    title: str = "Article",
    link: str = "https://example.com/1",
    pub_date: str = "Wed, 06 May 2026 11:00:00 +0000",
    description: str = "Summary",
    include_pubdate: bool = True,
) -> str:
    pubdate_xml = f"<pubDate>{pub_date}</pubDate>" if include_pubdate else ""
    return f"""<item>
        <title>{title}</title>
        <link>{link}</link>
        {pubdate_xml}
        <description>{description}</description>
    </item>"""


# An RSS feed with a single fresh entry (just past the fixed_now clock).
RSS_2_0_WELL_FORMED = _rss(
    _item(
        title="Article One",
        link="https://example.com/1",
        pub_date="Wed, 06 May 2026 11:00:00 +0000",
        description="Summary one",
    )
    + _item(
        title="Article Two",
        link="https://example.com/2",
        pub_date="Wed, 06 May 2026 10:00:00 +0000",
        description="Summary two",
    )
)


ATOM_FEED = """<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Test Atom</title>
  <link href="https://example.com"/>
  <entry>
    <title>Atom Article</title>
    <link href="https://example.com/atom-1"/>
    <published>2026-05-06T11:00:00Z</published>
    <summary>Atom summary</summary>
  </entry>
</feed>"""


# Atom entry with only <updated>, no <published>.
ATOM_UPDATED_ONLY = """<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Updated Only</title>
  <link href="https://example.com"/>
  <entry>
    <title>Updated Article</title>
    <link href="https://example.com/u-1"/>
    <updated>2026-05-06T11:00:00Z</updated>
    <summary>Updated summary</summary>
  </entry>
</feed>"""


# Bozo: unclosed tag in second item.
RSS_BOZO_MALFORMED = """<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Bozo Feed</title>
  <link>https://example.com</link>
  <item>
    <title>Valid</title>
    <link>https://example.com/valid</link>
    <pubDate>Wed, 06 May 2026 11:00:00 +0000</pubDate>
    <description>ok</description>
  </item>
  <item>
    <title>Broken
    <link>https://example.com/broken
    <pubDate>not-a-date</pubDate>
    <description>oops</description>
  </item>
</channel></rss>"""


# ---------------------------------------------------------------------------
# Autouse fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def mock_log(valid_env, monkeypatch):
    """Patch scraping.log on every test so no test ever exercises the real log()
    (which would attempt Supabase + create a real SQLite fallback file)."""
    log_mock = MagicMock()
    monkeypatch.setattr(scraping, "log", log_mock)
    return log_mock


@pytest.fixture(autouse=True)
def _reset_rate_limit_state():
    scraping._last_fetch.clear()
    scraping._last_retry_error.clear()
    yield
    scraping._last_fetch.clear()
    scraping._last_retry_error.clear()


@pytest.fixture(autouse=True)
def no_real_sleep(monkeypatch):
    """No test ever blocks on real sleep. Tests that care assert via .call_args."""
    sleep_mock = MagicMock()
    monkeypatch.setattr(scraping.time, "sleep", sleep_mock)
    return sleep_mock


@pytest.fixture(autouse=True)
def _allow_loopback_in_tests(monkeypatch):
    """SSRF defense rejects loopback / private IPs. Tests use https://example.com
    which IANA reserves; on most networks DNS resolution may map to a public IP,
    but on isolated CI the resolver may fail. Bypass by no-op'ing _validate_url
    EXCEPT in tests that explicitly test it. Those tests will re-monkeypatch
    back to the real implementation."""
    monkeypatch.setattr(scraping, "_validate_url", lambda url: None)


@pytest.fixture
def fixed_now(monkeypatch):
    """Freeze _now_utc() at 2026-05-06 12:00 UTC."""
    fixed = datetime(2026, 5, 6, 12, 0, tzinfo=UTC)
    monkeypatch.setattr(scraping, "_now_utc", lambda: fixed)
    return fixed


# ---------------------------------------------------------------------------
# Helper: inject MockTransport via _make_client
# ---------------------------------------------------------------------------


def _patch_make_client(monkeypatch, handler):
    """Replace scraping._make_client with one wired to a MockTransport built from
    handler. The lambda accepts **_kwargs so any production-side `transport=` kwarg
    is ignored — we always inject the mock. Production code never passes a
    transport at runtime; if a future refactor does, the lambda will TypeError
    loudly (a safety property, not a bug)."""
    mock_transport = httpx.MockTransport(handler)
    real_make = (
        scraping._make_client.__wrapped__
        if hasattr(scraping._make_client, "__wrapped__")
        else scraping._make_client
    )

    def _patched(**_kwargs):
        return real_make(transport=mock_transport)

    monkeypatch.setattr(scraping, "_make_client", _patched)
    return mock_transport


def _ok_response(content: bytes) -> httpx.Response:
    return httpx.Response(200, content=content)


def _rss_response(xml_str: str) -> httpx.Response:
    return _ok_response(xml_str.encode("utf-8"))


# ===========================================================================
# T2 — Happy path + tool decorator
# ===========================================================================


def test_fetch_rss_returns_normalized_entries_for_well_formed_feed(
    monkeypatch, fixed_now
):
    _patch_make_client(monkeypatch, lambda req: _rss_response(RSS_2_0_WELL_FORMED))

    result = fetch_rss("https://example.com/feed.xml", since_hours=24)

    assert isinstance(result, list)
    assert len(result) == 2
    for entry in result:
        assert set(entry.keys()) == {
            "title",
            "url",
            "published",
            "summary",
            "content_hash",
        }
        # published must round-trip through fromisoformat
        assert isinstance(datetime.fromisoformat(entry["published"]), datetime)
        # content_hash is sha256 hex of (title + \x00 + url)
        expected = hashlib.sha256(
            f"{entry['title']}\x00{entry['url']}".encode()
        ).hexdigest()
        assert entry["content_hash"] == expected
        assert len(entry["content_hash"]) == 64
        assert all(c in "0123456789abcdef" for c in entry["content_hash"])


def test_fetch_rss_logs_scrape_info_with_count_and_duration(
    monkeypatch, fixed_now, mock_log
):
    _patch_make_client(monkeypatch, lambda req: _rss_response(RSS_2_0_WELL_FORMED))

    fetch_rss("https://example.com/feed.xml", since_hours=24)

    info_calls = [c for c in mock_log.call_args_list if c.args[0] == "info"]
    assert len(info_calls) == 1
    args = info_calls[0].args
    assert args[1] == "scrape"
    md = info_calls[0].kwargs["metadata"]
    assert md["url"] == "https://example.com/feed.xml"
    assert md["since_hours"] == 24
    assert md["entries_returned"] == 2
    assert md["entries_seen"] == 2
    assert md["dropped_no_url"] == 0
    assert md["dropped_no_date"] == 0
    assert md["dropped_too_old"] == 0
    assert md["dropped_parse_error"] == 0
    assert md["bozo"] is False
    assert isinstance(md["duration_ms"], int)


def test_fetch_rss_is_callable_and_doc_preserved():
    assert callable(fetch_rss)
    assert fetch_rss.__doc__ is not None
    # GAIA's @tool must preserve the docstring contents the schema generator parses
    assert "since_hours" in fetch_rss.__doc__
    assert "Args:" in fetch_rss.__doc__
    assert "Returns:" in fetch_rss.__doc__


# ===========================================================================
# T3 — Date filtering, drop unparseable dates, Atom-updated fallback, URLs
# ===========================================================================


def _aged_feed(fixed_dt: datetime) -> str:
    """Build a feed with three pubDates: 5h, 30h, 200h before fixed_dt."""
    return _rss(
        _item(
            title="Five Hours",
            link="https://example.com/5h",
            pub_date=format_datetime(fixed_dt - timedelta(hours=5)),
        )
        + _item(
            title="Thirty Hours",
            link="https://example.com/30h",
            pub_date=format_datetime(fixed_dt - timedelta(hours=30)),
        )
        + _item(
            title="Two Hundred Hours",
            link="https://example.com/200h",
            pub_date=format_datetime(fixed_dt - timedelta(hours=200)),
        )
    )


@pytest.mark.parametrize(
    "since_hours,expected_count,expected_too_old",
    [(24, 1, 2), (168, 2, 1)],
)
def test_fetch_rss_filters_by_since_hours(
    monkeypatch, fixed_now, mock_log, since_hours, expected_count, expected_too_old
):
    feed_xml = _aged_feed(fixed_now)
    _patch_make_client(monkeypatch, lambda req: _rss_response(feed_xml))

    result = fetch_rss("https://example.com/feed.xml", since_hours=since_hours)

    assert len(result) == expected_count
    info_call = [c for c in mock_log.call_args_list if c.args[0] == "info"][0]
    assert info_call.kwargs["metadata"]["dropped_too_old"] == expected_too_old


def test_fetch_rss_drops_entries_without_pubdate(monkeypatch, fixed_now, mock_log):
    feed_xml = _rss(
        _item(title="Has Date", link="https://example.com/1")
        + _item(title="No Date", link="https://example.com/2", include_pubdate=False)
        + _item(title="Bad Date", link="https://example.com/3", pub_date="not-a-date")
    )
    _patch_make_client(monkeypatch, lambda req: _rss_response(feed_xml))

    result = fetch_rss("https://example.com/feed.xml", since_hours=24)

    assert len(result) == 1
    assert result[0]["title"] == "Has Date"
    info_call = [c for c in mock_log.call_args_list if c.args[0] == "info"][0]
    assert info_call.kwargs["metadata"]["dropped_no_date"] == 2


def test_fetch_rss_uses_updated_when_published_absent(monkeypatch, fixed_now):
    """Atom 1.0 entries with only <updated> (no <published>) MUST be retained.
    Without the updated_parsed fallback, every such entry is silently dropped —
    regression-guarded for simonwillison.net etc."""
    _patch_make_client(monkeypatch, lambda req: _rss_response(ATOM_UPDATED_ONLY))

    result = fetch_rss("https://example.com/atom.xml", since_hours=24)

    assert len(result) == 1
    assert result[0]["title"] == "Updated Article"
    assert result[0]["url"] == "https://example.com/u-1"
    assert datetime.fromisoformat(result[0]["published"]) == datetime(
        2026, 5, 6, 11, 0, tzinfo=UTC
    )


def _channel_dated_feed(channel_pub_date: str) -> str:
    """RSS feed with a channel-level <pubDate> but NO per-item dates (arxiv-style)."""
    return f"""<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Channel Dated Feed</title>
  <link>https://feed.example.com</link>
  <pubDate>{channel_pub_date}</pubDate>
  {_item(title="Dateless One", link="https://feed.example.com/1", include_pubdate=False)}
  {_item(title="Dateless Two", link="https://feed.example.com/2", include_pubdate=False)}
</channel></rss>"""


def test_fetch_rss_falls_back_to_channel_date_for_dateless_entries(
    monkeypatch, fixed_now
):
    """arxiv-style feeds expose only a channel-level <pubDate> and no per-item
    dates. Such entries MUST be retained using the channel date, not dropped as
    no_date (regression guard for export.arxiv.org/rss/cs.AI — issue #42)."""
    feed_xml = _channel_dated_feed("Wed, 06 May 2026 09:00:00 +0000")
    _patch_make_client(monkeypatch, lambda req: _rss_response(feed_xml))

    result = fetch_rss("https://feed.example.com/feed.xml", since_hours=24)

    assert len(result) == 2
    assert {e["title"] for e in result} == {"Dateless One", "Dateless Two"}
    for e in result:
        assert datetime.fromisoformat(e["published"]) == datetime(
            2026, 5, 6, 9, 0, tzinfo=UTC
        )


def test_fetch_rss_drops_dateless_entries_when_channel_date_too_old(
    monkeypatch, fixed_now, mock_log
):
    """The channel-date fallback is still subject to the cutoff: a stale channel
    date must filter the date-less entries out as too_old, not keep them."""
    # fixed_now = 2026-05-06 12:00 UTC; channel date ~8 days earlier is outside 24h.
    feed_xml = _channel_dated_feed("Mon, 28 Apr 2026 04:00:00 +0000")
    _patch_make_client(monkeypatch, lambda req: _rss_response(feed_xml))

    result = fetch_rss("https://feed.example.com/feed.xml", since_hours=24)

    assert result == []
    info_call = [c for c in mock_log.call_args_list if c.args[0] == "info"][0]
    assert info_call.kwargs["metadata"]["dropped_too_old"] == 2
    assert info_call.kwargs["metadata"]["dropped_no_date"] == 0


@pytest.mark.parametrize("bad_link", ["javascript:void(0)", "mailto:x@y.z"])
def test_fetch_rss_drops_entries_with_unresolvable_url(
    monkeypatch, fixed_now, mock_log, bad_link
):
    feed_xml = _rss(
        _item(title="Good", link="https://example.com/ok")
        + _item(title="Bad", link=bad_link)
    )
    _patch_make_client(monkeypatch, lambda req: _rss_response(feed_xml))

    result = fetch_rss("https://example.com/feed.xml", since_hours=24)

    assert len(result) == 1
    assert result[0]["title"] == "Good"
    info_call = [c for c in mock_log.call_args_list if c.args[0] == "info"][0]
    assert info_call.kwargs["metadata"]["dropped_no_url"] == 1


def test_fetch_rss_resolves_relative_entry_urls_against_channel_link(
    monkeypatch, fixed_now
):
    feed_xml = _rss(
        _item(title="Rel", link="/posts/foo"),
        channel_link="https://blog.example.com",
    )
    _patch_make_client(monkeypatch, lambda req: _rss_response(feed_xml))

    result = fetch_rss("https://blog.example.com/feed.xml", since_hours=24)

    assert len(result) == 1
    assert result[0]["url"] == "https://blog.example.com/posts/foo"


def test_fetch_rss_parses_atom_1_0_feed(monkeypatch, fixed_now):
    _patch_make_client(monkeypatch, lambda req: _rss_response(ATOM_FEED))

    result = fetch_rss("https://example.com/atom.xml", since_hours=24)

    assert len(result) == 1
    assert set(result[0].keys()) == {
        "title",
        "url",
        "published",
        "summary",
        "content_hash",
    }
    assert result[0]["url"] == "https://example.com/atom-1"


# ===========================================================================
# T4 — Rate limit
# ===========================================================================


def test_fetch_rss_throttles_repeat_calls_to_same_domain(
    monkeypatch, fixed_now, no_real_sleep
):
    _patch_make_client(monkeypatch, lambda req: _rss_response(RSS_2_0_WELL_FORMED))

    fetch_rss("https://example.com/feed-a.xml", since_hours=24)
    fetch_rss("https://example.com/feed-b.xml", since_hours=24)

    # The second call should have triggered at least one positive-duration sleep.
    assert no_real_sleep.call_count >= 1
    first_arg = no_real_sleep.call_args_list[0].args[0]
    assert first_arg > 0  # NOT pytest.approx(1.5) — would be flaky on loaded CI


def test_fetch_rss_does_not_throttle_across_domains(
    monkeypatch, fixed_now, no_real_sleep
):
    _patch_make_client(monkeypatch, lambda req: _rss_response(RSS_2_0_WELL_FORMED))

    fetch_rss("https://a.example.com/feed.xml", since_hours=24)
    fetch_rss("https://b.example.com/feed.xml", since_hours=24)

    # Distinct domains must not throttle. _throttle skips time.sleep when
    # wait <= 0, so call_count MUST be 0 — sharper than a tolerant `or`
    # branch that would vacuously pass.
    assert no_real_sleep.call_count == 0


# ===========================================================================
# T5 — Retry / 4xx / SSRF / size-cap / never-raises
# ===========================================================================


def _counting_handler(responses):
    """Build an httpx handler that returns the i-th item in `responses` per call.
    `responses[i]` may be a callable raising httpx exceptions, or a Response."""
    state = {"i": 0}

    def handler(request):
        i = state["i"]
        state["i"] += 1
        item = responses[min(i, len(responses) - 1)]
        if callable(item):
            return item(request)
        return item

    handler.calls = state
    return handler


def test_fetch_rss_retries_on_connect_error_then_succeeds(monkeypatch, fixed_now):
    def raise_connect(req):
        raise httpx.ConnectError("boom")

    handler = _counting_handler(
        [raise_connect, raise_connect, _rss_response(RSS_2_0_WELL_FORMED)]
    )
    _patch_make_client(monkeypatch, handler)

    result = fetch_rss("https://example.com/feed.xml", since_hours=24)

    assert handler.calls["i"] == 3
    assert len(result) == 2


def test_fetch_rss_returns_empty_after_retry_exhaustion(
    monkeypatch, fixed_now, mock_log
):
    def raise_connect(req):
        raise httpx.ConnectError("dns failed")

    handler = _counting_handler([raise_connect])
    _patch_make_client(monkeypatch, handler)

    result = fetch_rss("https://example.com/feed.xml", since_hours=24)

    assert result == []
    # exactly one warn record for the failure (no preceding info)
    warn_calls = [c for c in mock_log.call_args_list if c.args[0] == "warn"]
    assert len(warn_calls) == 1
    md = warn_calls[0].kwargs["metadata"]
    assert (
        "all retries exhausted" in warn_calls[0].args[2]
        or "exhausted" in warn_calls[0].args[2]
    )
    assert md["last_error_class"] == "ConnectError"
    # info log should NOT fire when we returned early
    info_calls = [c for c in mock_log.call_args_list if c.args[0] == "info"]
    assert info_calls == []


@pytest.mark.parametrize("status_code", [400, 401, 403, 404, 410, 451])
def test_fetch_rss_does_not_retry_on_4xx(monkeypatch, fixed_now, mock_log, status_code):
    handler = _counting_handler([httpx.Response(status_code)])
    _patch_make_client(monkeypatch, handler)

    result = fetch_rss("https://example.com/feed.xml", since_hours=24)

    assert result == []
    assert handler.calls["i"] == 1  # no retry
    # exactly one log call (regression test for the original double-log bug)
    assert mock_log.call_count == 1
    args = mock_log.call_args.args
    md = mock_log.call_args.kwargs["metadata"]
    assert args[0] == "warn"
    assert args[1] == "scrape"
    assert md["status_code"] == status_code


def test_fetch_rss_RETRIES_on_429(monkeypatch, fixed_now):
    """429 means 'back off and retry'. Must NOT be in the non-retryable set."""
    handler = _counting_handler(
        [httpx.Response(429), httpx.Response(429), _rss_response(RSS_2_0_WELL_FORMED)]
    )
    _patch_make_client(monkeypatch, handler)

    result = fetch_rss("https://example.com/feed.xml", since_hours=24)

    assert handler.calls["i"] == 3
    assert len(result) == 2


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/feed",
        "http://localhost/feed",
        "http://169.254.169.254/",
        "http://10.0.0.1/feed",
        "http://192.168.1.1/feed",
    ],
)
def test_fetch_rss_rejects_loopback_url(monkeypatch, mock_log, url):
    """SSRF defense: blocked IPs must not reach the network."""
    # Restore the real validator (autouse fixture replaces it with a no-op).
    monkeypatch.setattr(scraping, "_validate_url", _REAL_VALIDATE_URL)
    handler = _counting_handler([_rss_response(RSS_2_0_WELL_FORMED)])
    _patch_make_client(monkeypatch, handler)

    result = fetch_rss(url, since_hours=24)

    assert result == []
    assert handler.calls["i"] == 0  # never reached the network
    warn_calls = [c for c in mock_log.call_args_list if c.args[0] == "warn"]
    assert len(warn_calls) == 1
    msg = warn_calls[0].args[2]
    assert "blocked" in msg.lower() or "unsafe" in msg.lower()


@pytest.mark.parametrize(
    "url",
    ["ftp://example.com/feed", "file:///etc/passwd", "gopher://example.com/"],
)
def test_fetch_rss_rejects_non_http_scheme(monkeypatch, mock_log, url):
    monkeypatch.setattr(scraping, "_validate_url", _REAL_VALIDATE_URL)

    result = fetch_rss(url, since_hours=24)

    assert result == []
    warn_calls = [c for c in mock_log.call_args_list if c.args[0] == "warn"]
    assert len(warn_calls) == 1


def test_fetch_rss_rejects_oversized_response(monkeypatch, fixed_now, mock_log):
    """Response body > 10 MB raises _NonRetryableHttp(413), no retry."""
    big = b"x" * (11 * 1024 * 1024)
    handler = _counting_handler([httpx.Response(200, content=big)])
    _patch_make_client(monkeypatch, handler)

    result = fetch_rss("https://example.com/feed.xml", since_hours=24)

    assert result == []
    assert handler.calls["i"] == 1  # 413 is non-retryable
    md = mock_log.call_args.kwargs["metadata"]
    assert md["status_code"] == 413


def test_fetch_rss_processes_valid_entries_when_bozo(monkeypatch, fixed_now, mock_log):
    _patch_make_client(monkeypatch, lambda req: _rss_response(RSS_BOZO_MALFORMED))

    result = fetch_rss("https://example.com/feed.xml", since_hours=24)

    assert len(result) == 1
    # Pin call counts by level — guards against a future refactor that turns
    # the bozo log into a per-entry warn (volume bug).
    levels = Counter(call.args[0] for call in mock_log.call_args_list)
    assert levels == Counter({"warn": 1, "info": 1})
    info_call = [c for c in mock_log.call_args_list if c.args[0] == "info"][0]
    assert info_call.kwargs["metadata"]["bozo"] is True


def test_fetch_rss_never_raises_when_helper_throws_unexpected(
    monkeypatch, fixed_now, mock_log
):
    def boom(*_a, **_kw):
        raise RuntimeError("boom")

    monkeypatch.setattr(scraping, "_fetch_bytes", boom)

    result = fetch_rss("https://example.com/feed.xml", since_hours=24)

    assert result == []
    warn_calls = [c for c in mock_log.call_args_list if c.args[0] == "warn"]
    assert len(warn_calls) == 1
    md = warn_calls[0].kwargs["metadata"]
    assert md["error_class"] == "RuntimeError"


@pytest.mark.parametrize("since_hours", [0, -1, -24])
def test_fetch_rss_returns_empty_for_non_positive_since_hours(
    monkeypatch, fixed_now, mock_log, since_hours
):
    """No HTTP call should happen for invalid since_hours."""
    handler = _counting_handler([_rss_response(RSS_2_0_WELL_FORMED)])
    _patch_make_client(monkeypatch, handler)

    result = fetch_rss("https://example.com/feed.xml", since_hours=since_hours)

    assert result == []
    assert handler.calls["i"] == 0  # never reached the network
    warn_calls = [c for c in mock_log.call_args_list if c.args[0] == "warn"]
    assert len(warn_calls) == 1


# ===========================================================================
# T6 — fetch_html (issue #6)
# ===========================================================================


HTML_PAGE = """<!DOCTYPE html>
<html>
<head><title>Listing Page</title></head>
<body>
  <nav><a href="/home">Home</a></nav>
  <main id="content">
    <p>Featured stories this week.</p>
    <a href="/posts/alpha">Alpha</a>
    <a href="https://other.example.com/beta">Beta</a>
    <a href="mailto:editor@example.com">Email</a>
  </main>
  <footer><a href="/about">About</a></footer>
</body>
</html>"""


def _html_response(html_str: str) -> httpx.Response:
    return _ok_response(html_str.encode("utf-8"))


def test_fetch_html_returns_title_content_links_without_selector(monkeypatch):
    _patch_make_client(monkeypatch, lambda req: _html_response(HTML_PAGE))

    result = fetch_html("https://example.com/list")

    assert set(result.keys()) == {"title", "content", "links", "url", "fetched_at"}
    assert result["title"] == "Listing Page"
    # Whole-body text (no selector): nav + main + footer text all present.
    assert "Featured stories this week." in result["content"]
    assert "Home" in result["content"]
    assert "About" in result["content"]
    # Relative links resolved against the page URL; mailto dropped; order kept.
    assert result["links"] == [
        "https://example.com/home",
        "https://example.com/posts/alpha",
        "https://other.example.com/beta",
        "https://example.com/about",
    ]


def test_fetch_html_scopes_extraction_to_selector(monkeypatch):
    _patch_make_client(monkeypatch, lambda req: _html_response(HTML_PAGE))

    result = fetch_html("https://example.com/list", selector="#content")

    # Only the #content subtree contributes — nav/footer excluded.
    assert "Featured stories this week." in result["content"]
    assert "Home" not in result["content"]
    assert "About" not in result["content"]
    assert result["links"] == [
        "https://example.com/posts/alpha",
        "https://other.example.com/beta",
    ]


def test_fetch_html_selector_no_match_returns_empty_not_error(monkeypatch):
    _patch_make_client(monkeypatch, lambda req: _html_response(HTML_PAGE))

    result = fetch_html("https://example.com/list", selector=".does-not-exist")

    assert result["content"] == ""
    assert result["links"] == []
    assert "error" not in result  # a clean fetch with 0 matches is not an error


def test_fetch_html_returns_error_dict_on_4xx_without_raising(monkeypatch):
    handler = _counting_handler([httpx.Response(404)])
    _patch_make_client(monkeypatch, handler)

    result = fetch_html("https://example.com/missing")

    assert result["error"] == "http_404"
    assert result["content"] == "" and result["links"] == []
    assert handler.calls["i"] == 1  # 4xx is non-retryable


def test_fetch_html_rejects_unsafe_url(monkeypatch, mock_log):
    monkeypatch.setattr(scraping, "_validate_url", _REAL_VALIDATE_URL)
    handler = _counting_handler([_html_response(HTML_PAGE)])
    _patch_make_client(monkeypatch, handler)

    result = fetch_html("http://127.0.0.1/admin")

    assert result["error"].startswith("unsafe_url")
    assert handler.calls["i"] == 0  # never reached the network


def test_fetch_html_is_tool_with_doc_preserved():
    assert callable(fetch_html)
    assert fetch_html.__doc__ is not None
    assert "selector" in fetch_html.__doc__
    assert "Returns:" in fetch_html.__doc__


# ===========================================================================
# T7 — parse_article (issue #6)
# ===========================================================================


ARTICLE_HTML = """<!DOCTYPE html>
<html>
<head>
  <title>New Open-Weights Model Released</title>
  <meta name="author" content="Jane Doe"/>
  <meta property="article:published_time" content="2026-05-20T08:00:00Z"/>
</head>
<body>
  <nav>Home About Contact</nav>
  <article>
    <h1>New Open-Weights Model Released</h1>
    <p>A new open-weights language model was released today by a research lab,
    marking a notable step for local inference. The model targets consumer
    hardware and ships with a permissive license for developers everywhere.</p>
    <p>According to the announcement, the model improves reasoning while keeping
    memory requirements modest. Early testers report strong tool-calling
    behaviour and stable long-context performance across a wide range of tasks.</p>
    <p>The release includes quantized variants intended for laptops and edge
    devices, alongside documentation and example code to help teams get started.</p>
  </article>
  <footer>Copyright 2026</footer>
</body>
</html>"""


def test_parse_article_extracts_body_and_metadata(monkeypatch):
    """Exercises the real trafilatura extraction offline (HTML supplied via the
    mock transport — trafilatura itself does no network I/O)."""
    _patch_make_client(monkeypatch, lambda req: _html_response(ARTICLE_HTML))

    result = parse_article("https://example.com/article")

    assert set(result.keys()) == {
        "title",
        "content",
        "author",
        "date",
        "url",
        "fetched_at",
    }
    assert "open-weights language model" in result["content"]
    # Boilerplate (nav/footer) is stripped by trafilatura's main-content model.
    assert "Copyright 2026" not in result["content"]
    assert result["title"]
    assert result["url"] == "https://example.com/article"


def test_parse_article_no_main_content_returns_error(monkeypatch):
    _patch_make_client(monkeypatch, lambda req: _html_response(HTML_PAGE))
    # Deterministic: force trafilatura to find nothing extractable.
    monkeypatch.setattr(scraping.trafilatura, "extract", lambda *a, **k: None)

    result = parse_article("https://example.com/thin")

    assert result["error"] == "no_content"
    assert result["content"] == ""


def test_parse_article_handles_extraction_exception(monkeypatch):
    _patch_make_client(monkeypatch, lambda req: _html_response(ARTICLE_HTML))

    def _boom(*_a, **_kw):
        raise ValueError("bad html")

    monkeypatch.setattr(scraping.trafilatura, "extract", _boom)

    result = parse_article("https://example.com/article")

    assert result["error"].startswith("extract_error")
    assert result["content"] == ""


def test_parse_article_handles_malformed_json(monkeypatch):
    """trafilatura returning a non-JSON string must not raise out of the tool."""
    _patch_make_client(monkeypatch, lambda req: _html_response(ARTICLE_HTML))
    monkeypatch.setattr(scraping.trafilatura, "extract", lambda *a, **k: "not json{{{")

    result = parse_article("https://example.com/article")

    assert result["error"] == "json_decode_error"
    assert result["content"] == ""


def test_parse_article_returns_error_dict_on_4xx(monkeypatch):
    handler = _counting_handler([httpx.Response(404)])
    _patch_make_client(monkeypatch, handler)

    result = parse_article("https://example.com/missing")

    assert result["error"] == "http_404"
    assert handler.calls["i"] == 1


# ===========================================================================
# T9 — Integration tests (excluded from CI)
# ===========================================================================


def _assert_real_feed_contract(result):
    """Contract-only assertions — no URL-specific values, so feed schema drift
    between writing and merging doesn't break the test for unrelated reasons."""
    assert isinstance(result, list)
    assert len(result) >= 1
    for entry in result:
        assert set(entry.keys()) == {
            "title",
            "url",
            "published",
            "summary",
            "content_hash",
        }
        assert entry["url"].startswith("https://")
        # published parses
        datetime.fromisoformat(entry["published"])
        assert len(entry["content_hash"]) == 64


@pytest.mark.integration
def test_fetch_rss_against_huggingface():
    result = fetch_rss("https://huggingface.co/blog/feed.xml", since_hours=720)
    _assert_real_feed_contract(result)


@pytest.mark.integration
def test_fetch_rss_against_arxiv():
    """arxiv cs.AI exposes only a channel-level <pubDate> with no per-item dates,
    so entries survive only via the channel-date fallback (issue #42). arxiv also
    skips weekends (<skipDays>Sat,Sun</skipDays>), so the live feed is legitimately
    empty then. Validate the contract when items are present; accept [] only when
    the live feed truly has no <item> (otherwise the fallback has regressed)."""
    url = "https://export.arxiv.org/rss/cs.AI"
    result = fetch_rss(url, since_hours=720)
    assert isinstance(result, list)
    if result:
        _assert_real_feed_contract(result)
        return
    raw = httpx.get(
        url,
        timeout=15,
        follow_redirects=True,
        headers={"User-Agent": "news-digest-agent-test"},
    ).text
    assert "<item" not in raw, (
        "arxiv feed contains items but fetch_rss returned none — "
        "channel-date fallback (issue #42) regressed"
    )


@pytest.mark.integration
def test_fetch_rss_against_simon_willison():
    result = fetch_rss("https://simonwillison.net/atom/everything/", since_hours=720)
    _assert_real_feed_contract(result)


@pytest.mark.integration
def test_fetch_html_against_real_page():
    result = fetch_html("https://example.com/")
    assert "error" not in result
    assert result["title"]
    assert "example" in result["content"].lower()


@pytest.mark.integration
def test_parse_article_against_real_page():
    # A stable, text-heavy page that trafilatura extracts reliably.
    result = parse_article("https://en.wikipedia.org/wiki/Pittsburgh_Penguins")
    assert "error" not in result
    assert result["title"]
    assert len(result["content"]) > 500
