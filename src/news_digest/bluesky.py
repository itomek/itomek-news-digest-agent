"""Public Bluesky evidence queue. This module cannot authenticate or publish."""

import argparse
import json
import re
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx

ENDPOINT = "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed"
HANDLE = re.compile(
    r"(?=.{3,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$"
)
URI = re.compile(
    r"at://(did:[a-z]+:[A-Za-z0-9._:%-]+)/app\.bsky\.feed\.post/([A-Za-z0-9._~-]+)$"
)


def fetch_feed(actor):
    """One fixed-host GET, 100 records maximum, no redirects/retries/auth."""
    with httpx.Client(timeout=15, follow_redirects=False, trust_env=True) as client:
        with client.stream(
            "GET",
            ENDPOINT,
            params={"actor": actor, "limit": 100, "filter": "posts_no_replies"},
            headers={"User-Agent": "WarpCoreEvidence/0.1"},
        ) as response:
            response.raise_for_status()
            body = bytearray()
            for chunk in response.iter_bytes():
                body.extend(chunk)
                if len(body) > 2_000_000:
                    raise ValueError("Feed exceeds 2 MB")
            return json.loads(body)


def collect(actors, terms, fetch=fetch_feed, now=None, seen=None):
    """Return candidates, not verified facts; never update published state."""
    if not isinstance(actors, list) or not 1 <= len(actors) <= 20:
        raise ValueError("Provide 1–20 handles")
    if any(not isinstance(a, str) or not HANDLE.fullmatch(a) for a in actors):
        raise ValueError("Actors must be Bluesky handles, not URLs or IP addresses")
    if (
        not isinstance(terms, list)
        or not terms
        or any(not isinstance(t, str) or not t.strip() or len(t) > 100 for t in terms)
        or len(terms) > 50
    ):
        raise ValueError("Provide 1–50 nonempty relevance terms, up to 100 characters")
    now = now or datetime.now(UTC)
    seen = set(seen or ())
    result = {
        "schema_version": 1,
        "generated_at": now.isoformat(),
        "publishing_enabled": False,
        "candidates": [],
        "sources": [],
    }
    for actor in dict.fromkeys(actors):
        state = {"actor": actor, "status": "ok", "added": 0}
        result["sources"].append(state)
        try:
            data = fetch(actor)
            if not isinstance(data, dict) or not isinstance(data.get("feed"), list):
                raise ValueError("Invalid feed")
            for entry in data["feed"][:100]:
                if not isinstance(entry, dict) or "reason" in entry:
                    continue
                post = entry.get("post", {})
                if not isinstance(post, dict):
                    continue
                record = post.get("record", {})
                if not isinstance(record, dict) or "reply" in record:
                    continue
                text, uri = record.get("text"), post.get("uri")
                match = URI.fullmatch(uri) if isinstance(uri, str) else None
                if not isinstance(text, str) or not match or uri in seen:
                    continue
                try:
                    date = datetime.fromisoformat(
                        record["createdAt"].replace("Z", "+00:00")
                    )
                    if (
                        date.tzinfo is None
                        or not now - timedelta(hours=24) <= date <= now
                    ):
                        continue
                except (KeyError, ValueError, TypeError, AttributeError):
                    continue
                matched = [t for t in terms if t.casefold() in text.casefold()]
                if not matched:
                    continue
                seen.add(uri)
                result["candidates"].append(
                    {
                        "uri": uri,
                        "url": f"https://bsky.app/profile/{match[1]}/post/{match[2]}",
                        "text": text[:20000],
                        "published_at": date.isoformat(),
                        "source_actor": actor,
                        "matched_terms": matched,
                        "evidence": "unverified_social_post",
                        "review_required": True,
                    }
                )
                state["added"] += 1
            if not data["feed"]:
                state["status"] = "empty"
        except (httpx.HTTPError, ValueError, TypeError, RuntimeError):
            state["status"] = "error"
            state["error"] = "Feed unavailable or invalid; not a quiet-news result"
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument(
        "--seen",
        type=Path,
        help="JSON array of previously reviewed/published AT URIs; read-only",
    )
    args = parser.parse_args()
    try:
        for source in (args.config, args.seen):
            if source and (
                args.output.resolve() == source.resolve()
                or (
                    args.output.exists()
                    and source.exists()
                    and args.output.samefile(source)
                )
            ):
                raise ValueError("Output must not overwrite config or seen input")
        config = json.loads(args.config.read_text())
        seen = json.loads(args.seen.read_text()) if args.seen else []
        if (
            not isinstance(config, dict)
            or not isinstance(seen, list)
            or any(not isinstance(x, str) for x in seen)
        ):
            raise ValueError("Invalid config or seen file")
        result = collect(config.get("actors"), config.get("terms"), seen=seen)
        args.output.write_text(json.dumps(result, indent=2) + "\n")
        return 0 if any(s["status"] != "error" for s in result["sources"]) else 1
    except (OSError, ValueError) as exc:
        print(f"Cannot prepare review queue: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
