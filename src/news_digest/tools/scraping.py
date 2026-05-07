"""Scraping tools for the News Digest Agent.

Each function is decorated with @tool and registered with the agent.
The LLM decides which tools to call and in what order.

Tools:
    fetch_rss: Parse an RSS/Atom feed and return recent entries.
    fetch_html: (issue #6) Scrape an HTML page with an optional CSS selector.
    parse_article: (issue #6) Extract full article content from a URL.

Note on architecture deviation: docs/architecture.md §5.3 shows @retry directly
on the public tool function. We deviate intentionally: @retry lives on the
private _fetch_feed_bytes helper, and fetch_rss owns error translation. This
preserves the @tool contract that the LLM always receives a list[dict] and the
function never raises.
"""

import hashlib
import ipaddress
import socket
import sys
import threading
import time
from calendar import timegm
from collections import Counter
from datetime import UTC, datetime, timedelta
from urllib.parse import urljoin, urlparse

import feedparser
import httpx
from gaia.agents.base.tools import tool
from tenacity import (
    retry,
    retry_if_not_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from news_digest.logging import log


class _NonRetryableHttp(Exception):
    """Raised by _fetch_feed_bytes on non-retryable HTTP outcomes (4xx except 429,
    or response-too-large 413). Tenacity is configured to skip retry on this.
    fetch_rss catches it, logs once, and returns []."""

    def __init__(self, status_code: int, url: str) -> None:
        self.status_code = status_code
        self.url = url
        super().__init__(f"HTTP {status_code} for {url}")


class _UnsafeUrl(Exception):
    """Raised by _validate_url when a URL fails SSRF defenses."""

    def __init__(self, reason: str, url: str) -> None:
        self.reason = reason
        self.url = url
        super().__init__(f"unsafe url: {reason} ({url})")


_RATE_LIMIT_SECONDS: float = 1.5
_CONNECT_TIMEOUT: float = 3.0
_TOTAL_TIMEOUT: float = 15.0
_MAX_RESPONSE_BYTES: int = 10 * 1024 * 1024  # 10 MB
_USER_AGENT: str = (
    "news-digest-agent/0.1 (+https://github.com/itomek/itomek-news-digest-agent)"
)

# Per-domain last-fetch timestamp (monotonic clock). See _throttle.
_last_fetch: dict[str, float] = {}
_rate_lock: threading.Lock = threading.Lock()

# Captures the last exception from a retried fetch so fetch_rss can log it
# with class+message after retry exhaustion. Keyed by id(callable) to avoid
# any future collision if multiple retried helpers exist.
_last_retry_error: dict[int, BaseException] = {}


def _now_utc() -> datetime:
    """Indirection seam so tests can monkeypatch time without touching `datetime`."""
    return datetime.now(UTC)


def _make_client(transport: httpx.BaseTransport | None = None) -> httpx.Client:
    return httpx.Client(
        transport=transport,
        timeout=httpx.Timeout(_TOTAL_TIMEOUT, connect=_CONNECT_TIMEOUT),
        follow_redirects=True,
        headers={"User-Agent": _USER_AGENT},
    )


def _domain_of(url: str) -> str:
    return urlparse(url).netloc.lower()


def _validate_url(url: str) -> None:
    """SSRF defense. Raises _UnsafeUrl on dangerous targets.

    Rejects: non-http(s) schemes; hosts that resolve to loopback / RFC1918 /
    link-local / multicast / reserved IPs.
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise _UnsafeUrl(f"scheme {parsed.scheme!r} not in (http, https)", url)
    host = parsed.hostname
    if not host:
        raise _UnsafeUrl("no hostname", url)
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise _UnsafeUrl(f"DNS error: {exc}", url) from exc
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if (
            ip.is_loopback
            or ip.is_private
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
        ):
            raise _UnsafeUrl(f"host resolves to {ip} (blocked)", url)


def _throttle(domain: str) -> None:
    # Reserve slot inside lock, then sleep outside — holding the lock during
    # sleep would serialize all domains. Slot is reserved pessimistically.
    now = time.monotonic()
    with _rate_lock:
        last = _last_fetch.get(domain, 0.0)
        elapsed = now - last
        wait = _RATE_LIMIT_SECONDS - elapsed
        if wait > 0:
            _last_fetch[domain] = now + wait  # reserve slot
        else:
            _last_fetch[domain] = now
            wait = 0.0
    if wait > 0:
        time.sleep(wait)


def _content_hash(title: str, url: str) -> str:
    # Null byte separator: title and url cannot contain it, so no
    # ("foo|", "bar") vs ("foo", "|bar") collision risk.
    # NOTE: no URL canonicalization. analysis.deduplicate_articles must
    # regenerate hashes if it adds canonicalization later.
    return hashlib.sha256(f"{title}\x00{url}".encode()).hexdigest()


def _to_utc_dt(parsed) -> datetime | None:
    """Convert feedparser's struct_time (UTC) to aware datetime.
    Returns None on failure."""
    if parsed is None:
        return None
    try:
        return datetime.fromtimestamp(timegm(parsed), tz=UTC)
    except (OverflowError, OSError, ValueError, TypeError):
        return None


def _resolve_url(feed_link: str, entry_link: str) -> str | None:
    if not entry_link:
        return None
    resolved = urljoin(feed_link or "", entry_link)
    if not resolved.startswith(("http://", "https://")):
        return None
    return resolved


def _parse_entry(entry, feed_link: str, cutoff: datetime) -> dict | str:
    """Parse one feedparser entry.

    Returns the entry dict on success, or a short reason string on drop
    ('no_url', 'no_date', 'too_old', 'parse_error'). fetch_rss aggregates the
    reasons into the success log's metadata for diagnosability.
    """
    try:
        title = (getattr(entry, "title", "") or "").strip()
        raw_link = getattr(entry, "link", "") or ""
        url = _resolve_url(feed_link, raw_link)
        if not url:
            return "no_url"
        # Atom: prefer <published>, fall back to <updated>. Real-world Atom feeds
        # often emit only <updated>; without the fallback they silently drop.
        parsed_time = getattr(entry, "published_parsed", None) or getattr(
            entry, "updated_parsed", None
        )
        published_dt = _to_utc_dt(parsed_time)
        if published_dt is None:
            return "no_date"
        if published_dt < cutoff:
            return "too_old"
        summary = getattr(entry, "summary", "") or ""
        return {
            "title": title,
            "url": url,
            "published": published_dt.isoformat(),
            "summary": summary,
            "content_hash": _content_hash(title, url),
        }
    except Exception:
        return "parse_error"


def _retry_returns_none(retry_state) -> None:
    """Tenacity callback after retries are exhausted. Captures the final
    exception (so fetch_rss can log it with class+message) and returns None
    as a sentinel."""
    exc = retry_state.outcome.exception() if retry_state.outcome else None
    if exc is not None:
        _last_retry_error[id(_fetch_feed_bytes)] = exc
    return None


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, max=30),
    reraise=False,
    retry=retry_if_not_exception_type(_NonRetryableHttp),
    retry_error_callback=_retry_returns_none,
)
def _fetch_feed_bytes(
    url: str, transport: httpx.BaseTransport | None = None
) -> bytes | None:
    """Fetch raw feed bytes with a hard 10 MB body cap.

    NEVER calls log() — all logging happens in fetch_rss to preserve the
    one-failure-one-log invariant.

    Raises:
        _NonRetryableHttp(status_code, url): on 4xx EXCEPT 429, or 413 when
            the body exceeds the size cap. Tenacity skips retry; fetch_rss
            catches and logs once.
        httpx.HTTPStatusError / httpx.RequestError: on 5xx / network / 429 —
            tenacity retries.

    Returns:
        bytes on success.
        None when retries are exhausted (via retry_error_callback).
    """
    with _make_client(transport=transport) as client:
        with client.stream("GET", url) as resp:
            # 4xx EXCEPT 429: deterministic, no retry.
            if 400 <= resp.status_code < 500 and resp.status_code != 429:
                # Close the stream BEFORE raising so __exit__ doesn't try to
                # drain a (potentially large) body on the way out.
                resp.close()
                raise _NonRetryableHttp(resp.status_code, url)
            # 429 and 5xx fall through to raise_for_status → tenacity retries.
            resp.raise_for_status()
            buf = bytearray()
            for chunk in resp.iter_bytes(8192):
                buf.extend(chunk)
                if len(buf) > _MAX_RESPONSE_BYTES:
                    # Same: close before raising so we don't waste bandwidth
                    # draining the rest of an oversized payload.
                    resp.close()
                    raise _NonRetryableHttp(413, url)
            return bytes(buf)


@tool
def fetch_rss(url: str, since_hours: int = 24) -> list[dict]:
    """Fetch and parse an RSS or Atom feed, returning recent entries.

    Args:
        url: The feed URL.
        since_hours: Only return entries published within this window.
            Use 24 for daily topics, 168 for weekly.

    Returns:
        List of dicts, each with keys: title, url, published (ISO-8601 UTC),
        summary, content_hash. Entries without parseable dates are dropped.
        Returns [] on fetch failure (the call never raises).
    """
    t_start = time.monotonic()

    # Input validation — short-circuit before any network or sleep.
    if since_hours <= 0:
        log(
            "warn",
            "scrape",
            f"fetch_rss: since_hours={since_hours} <= 0",
            metadata={"url": url, "since_hours": since_hours},
        )
        return []

    try:
        _validate_url(url)
    except _UnsafeUrl as exc:
        log(
            "warn",
            "scrape",
            f"fetch_rss: blocked unsafe url: {exc.reason}",
            metadata={"url": url, "reason": exc.reason},
        )
        return []

    domain = _domain_of(url)
    _throttle(domain)

    raw: bytes | None
    try:
        raw = _fetch_feed_bytes(url)
    except _NonRetryableHttp as exc:
        log(
            "warn",
            "scrape",
            f"fetch_rss: HTTP {exc.status_code} (non-retryable) for {url}",
            metadata={"url": url, "status_code": exc.status_code},
        )
        return []
    except Exception as exc:
        log(
            "warn",
            "scrape",
            f"fetch_rss: unexpected error for {url}: {exc.__class__.__name__}: {exc}",
            metadata={
                "url": url,
                "error_class": exc.__class__.__name__,
                "error": str(exc),
            },
        )
        return []

    if raw is None:
        # Retries exhausted on 5xx / transport / timeout / 429.
        last = _last_retry_error.pop(id(_fetch_feed_bytes), None)
        log(
            "warn",
            "scrape",
            f"fetch_rss: all retries exhausted for {url}: "
            f"{last.__class__.__name__ if last else 'unknown'}",
            metadata={
                "url": url,
                "since_hours": since_hours,
                "last_error_class": last.__class__.__name__ if last else None,
                "last_error": str(last) if last else None,
            },
        )
        return []

    feed = feedparser.parse(raw)
    bozo = bool(getattr(feed, "bozo", 0))
    if bozo:
        log(
            "warn",
            "scrape",
            f"fetch_rss: bozo feed at {url}",
            metadata={
                "url": url,
                "bozo_exception": str(getattr(feed, "bozo_exception", "")),
                "entries_parsed": len(getattr(feed, "entries", []) or []),
            },
        )

    cutoff = _now_utc() - timedelta(hours=since_hours)
    feed_obj = getattr(feed, "feed", None)
    feed_link = (
        feed_obj.get("link", "") if feed_obj and hasattr(feed_obj, "get") else ""
    ) or url

    entries: list[dict] = []
    drops: Counter[str] = Counter()
    for raw_entry in getattr(feed, "entries", []) or []:
        result = _parse_entry(raw_entry, feed_link, cutoff)
        if isinstance(result, dict):
            entries.append(result)
        else:
            drops[result] += 1

    log(
        "info",
        "scrape",
        f"fetch_rss: returned {len(entries)} entries from {url}",
        metadata={
            "url": url,
            "since_hours": since_hours,
            "entries_seen": len(getattr(feed, "entries", []) or []),
            "entries_returned": len(entries),
            "dropped_no_url": drops.get("no_url", 0),
            "dropped_no_date": drops.get("no_date", 0),
            "dropped_too_old": drops.get("too_old", 0),
            "dropped_parse_error": drops.get("parse_error", 0),
            "bozo": bozo,
            "duration_ms": round((time.monotonic() - t_start) * 1000),
        },
    )
    return entries


# Debug entry point: `python -m news_digest.tools.scraping <url> [since_hours]`.
# Bypasses scheduler / agent so a developer can validate one feed in seconds.
if __name__ == "__main__":  # pragma: no cover
    import json

    if len(sys.argv) < 2:
        print(
            "usage: python -m news_digest.tools.scraping <url> [since_hours]",
            file=sys.stderr,
        )
        sys.exit(2)
    _url = sys.argv[1]
    _since = int(sys.argv[2]) if len(sys.argv) > 2 else 24
    _result = fetch_rss(_url, since_hours=_since)
    print(
        json.dumps({"count": len(_result), "entries": _result}, indent=2, default=str)
    )
