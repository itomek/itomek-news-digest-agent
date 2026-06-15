// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { formatDate, renderDigestList } from "../../src/views/digest-list";
import type { Topic } from "../../src/lib/types";

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
