"""CLI entrypoint: `python -m news_digest "say hello"`.

Used for manual smoke runs. The scheduler is the production driver — see
`src/news_digest/scheduler.py` (Epic 4).
"""

import sys

from news_digest.agent import NewsDigestAgent


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print('usage: python -m news_digest "<query>"', file=sys.stderr)
        return 2

    query = argv[1]
    agent = NewsDigestAgent()
    result = agent.process_query(query)
    print(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
