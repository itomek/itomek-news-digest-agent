// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { formatDate, renderDigestList } from "../../src/views/digest-list";
import type { Digest, Topic } from "../../src/lib/types";

function digest(partial: Partial<Digest> & { topic_slug: string; digest_date: string }): Digest {
  return {
    id: `${partial.topic_slug}-${partial.digest_date}`,
    content: "x",
    cadence: "24h",
    sources_used: [],
    token_count: null,
    prompt_version: "v",
    created_at: `${partial.digest_date}T00:00:00Z`,
    summary: null,
    items: null,
    ...partial,
  };
}

// Regression for the Today-screen date rendering one day early (issue #92):
// a calendar digest_date must render the SAME day-of-month regardless of the
// viewer's timezone, because dateFmt pins timeZone: "UTC". Assertions are
// locale-independent (formatDate uses the system locale internally) — they
// check the day token, not the exact formatted string.
describe("formatDate", () => {
  it("keeps the day-of-month for a mid-month date (no tz shift back)", () => {
    const out = formatDate("2026-06-12");
    expect(out).toContain("12");
    expect(out).not.toContain("11"); // would appear if rendered in a UTC-behind zone
    expect(out).not.toContain("13"); // would appear if rendered in a UTC-ahead zone
  });

  it("keeps the day across a month boundary (UTC midnight, not local)", () => {
    const out = formatDate("2026-06-01");
    expect(out).toContain("1");
    expect(out).not.toContain("31"); // May 31 would appear if shifted back
  });

  it("returns the raw string for malformed input", () => {
    expect(formatDate("not-a-date")).toBe("not-a-date");
  });
});

// ── renderDigestList empty state (issue #100) ─────────────────────────────────

describe("renderDigestList empty state", () => {
  const topics: Topic[] = [
    { id: 1, name: "AI model releases", slug: "ai_models", cadence: "24h", enabled: true },
  ];

  it("shows 'No news items were found.' when given an empty array", () => {
    const el = renderDigestList([], topics);
    const empty = el.querySelector(".empty-state");
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toBe("No news items were found.");
  });

  it("does NOT show the old placeholder message", () => {
    const el = renderDigestList([], topics);
    expect(el.textContent).not.toContain("No digests yet");
    expect(el.textContent).not.toContain("Check back after the next run");
  });
});

// ── renderDigestList date-first grouping (issue #101) ─────────────────────────

describe("renderDigestList date-first grouping", () => {
  const topics: Topic[] = [
    { id: 1, name: "AI model releases", slug: "ai_models", cadence: "24h", enabled: true },
    { id: 2, name: "Local news", slug: "local_news", cadence: "7d", enabled: true },
  ];

  it("renders a date h2 at the top level", () => {
    const digests = [digest({ topic_slug: "ai_models", digest_date: "2026-06-14" })];
    const el = renderDigestList(digests, topics);
    const dateHeadings = el.querySelectorAll("section.date-group > h2.date-heading");
    expect(dateHeadings).toHaveLength(1);
    expect(dateHeadings[0].getAttribute("data-date")).toBe("2026-06-14");
  });

  it("renders topic h3 nested beneath the date heading", () => {
    const digests = [digest({ topic_slug: "ai_models", digest_date: "2026-06-14" })];
    const el = renderDigestList(digests, topics);
    const topicHeadings = el.querySelectorAll("section.date-group h3.topic-heading");
    expect(topicHeadings).toHaveLength(1);
    expect(topicHeadings[0].textContent).toBe("AI model releases");
  });

  it("lists multiple topics under the same date group", () => {
    const digests = [
      digest({ topic_slug: "ai_models", digest_date: "2026-06-14" }),
      digest({ topic_slug: "local_news", digest_date: "2026-06-14" }),
    ];
    const el = renderDigestList(digests, topics);
    const dateGroups = el.querySelectorAll("section.date-group");
    expect(dateGroups).toHaveLength(1);
    const topicHeadings = dateGroups[0].querySelectorAll("h3.topic-heading");
    expect(topicHeadings).toHaveLength(2);
  });

  it("renders multiple dates newest first", () => {
    const digests = [
      digest({ topic_slug: "ai_models", digest_date: "2026-06-13" }),
      digest({ topic_slug: "ai_models", digest_date: "2026-06-14" }),
    ];
    const el = renderDigestList(digests, topics);
    const dateHeadings = el.querySelectorAll("section.date-group h2.date-heading");
    const dates = Array.from(dateHeadings).map((h) => h.getAttribute("data-date"));
    expect(dates).toEqual(["2026-06-14", "2026-06-13"]);
  });
});
