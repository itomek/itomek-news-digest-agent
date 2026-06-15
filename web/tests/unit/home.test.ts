import { describe, expect, it } from "vitest";
import { isPublishableDigest, filterTodayDigests } from "../../src/pages/home";
import type { Digest } from "../../src/lib/types";

/** Minimal digest factory for tests. */
function digest(
  partial: Partial<Digest> & { topic_slug: string; digest_date: string; content: string },
): Digest {
  return {
    id: `${partial.topic_slug}-${partial.digest_date}`,
    cadence: "24h",
    sources_used: [],
    token_count: null,
    prompt_version: "v",
    created_at: `${partial.digest_date}T12:00:00Z`,
    summary: null,
    items: null,
    ...partial,
  };
}

// ── isPublishableDigest ───────────────────────────────────────────────────────

describe("isPublishableDigest", () => {
  it("keeps a digest with a non-empty items array", () => {
    const d = digest({
      topic_slug: "ai_models",
      digest_date: "2026-06-15",
      content: "",
      items: [
        { headline: "GPT-5 launches", blurb: "Big news", detail: "Details here" },
      ],
    });
    expect(isPublishableDigest(d)).toBe(true);
  });

  it("keeps a digest with non-filler content and null items", () => {
    const d = digest({
      topic_slug: "ai_models",
      digest_date: "2026-06-15",
      content: "Anthropic released Claude 4 today with major new capabilities.",
      items: null,
    });
    expect(isPublishableDigest(d)).toBe(true);
  });

  it("drops the exact filler: 'No new AI model releases were reported by curated sources today.'", () => {
    const d = digest({
      topic_slug: "ai_models",
      digest_date: "2026-06-15",
      content: "No new AI model releases were reported by curated sources today.",
      items: null,
    });
    expect(isPublishableDigest(d)).toBe(false);
  });

  it("drops content starting with 'no new' (case-insensitive)", () => {
    const d = digest({
      topic_slug: "ai_models",
      digest_date: "2026-06-15",
      content: "No new updates were found.",
      items: null,
    });
    expect(isPublishableDigest(d)).toBe(false);
  });

  it("drops content starting with 'no significant'", () => {
    const d = digest({
      topic_slug: "penguins",
      digest_date: "2026-06-15",
      content: "No significant news today.",
      items: null,
    });
    expect(isPublishableDigest(d)).toBe(false);
  });

  it("drops content starting with 'nothing'", () => {
    const d = digest({
      topic_slug: "local_news",
      digest_date: "2026-06-15",
      content: "Nothing to report this week.",
      items: null,
    });
    expect(isPublishableDigest(d)).toBe(false);
  });

  it("drops content starting with 'there were no'", () => {
    const d = digest({
      topic_slug: "ai_models",
      digest_date: "2026-06-15",
      content: "There were no new releases today.",
      items: null,
    });
    expect(isPublishableDigest(d)).toBe(false);
  });

  it("drops content containing 'were reported by curated sources'", () => {
    const d = digest({
      topic_slug: "ai_models",
      digest_date: "2026-06-15",
      content: "Only minor items were reported by curated sources this week.",
      items: null,
    });
    expect(isPublishableDigest(d)).toBe(false);
  });

  it("drops content containing 'no news'", () => {
    const d = digest({
      topic_slug: "ai_models",
      digest_date: "2026-06-15",
      content: "There is no news to summarize today.",
      items: null,
    });
    expect(isPublishableDigest(d)).toBe(false);
  });

  it("drops digest with empty content and null items", () => {
    const d = digest({
      topic_slug: "ai_models",
      digest_date: "2026-06-15",
      content: "",
      items: null,
    });
    expect(isPublishableDigest(d)).toBe(false);
  });

  it("drops digest with only-whitespace content and null items", () => {
    const d = digest({
      topic_slug: "ai_models",
      digest_date: "2026-06-15",
      content: "   ",
      items: null,
    });
    expect(isPublishableDigest(d)).toBe(false);
  });

  it("keeps digest with empty items array (treats it as no items — falls back to content)", () => {
    // An empty array is not a non-empty array, so we check content
    const d = digest({
      topic_slug: "ai_models",
      digest_date: "2026-06-15",
      content: "Real content here.",
      items: [],
    });
    expect(isPublishableDigest(d)).toBe(true);
  });

  it("drops digest with empty items array and filler content", () => {
    const d = digest({
      topic_slug: "ai_models",
      digest_date: "2026-06-15",
      content: "No new AI model releases were reported by curated sources today.",
      items: [],
    });
    expect(isPublishableDigest(d)).toBe(false);
  });
});

// ── filterTodayDigests ────────────────────────────────────────────────────────

describe("filterTodayDigests", () => {
  // Pin "now" to 2026-06-15T15:00:00Z → Eastern date 2026-06-15
  const now = new Date("2026-06-15T15:00:00Z");

  const todayReal = digest({
    topic_slug: "ai_models",
    digest_date: "2026-06-15",
    content: "Anthropic shipped Claude 4.",
    items: [{ headline: "Claude 4", blurb: "New model", detail: "Details" }],
  });

  const todayFiller = digest({
    topic_slug: "penguins",
    digest_date: "2026-06-15",
    content: "No new AI model releases were reported by curated sources today.",
    items: null,
  });

  const yesterdayReal = digest({
    topic_slug: "ai_models",
    digest_date: "2026-06-14",
    content: "Yesterday's big news.",
    items: null,
  });

  const oldReal = digest({
    topic_slug: "local_news",
    digest_date: "2026-06-01",
    content: "Old news.",
    items: null,
  });

  it("keeps today's real digest", () => {
    const out = filterTodayDigests([todayReal], now);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(todayReal);
  });

  it("drops today's filler digest", () => {
    const out = filterTodayDigests([todayFiller], now);
    expect(out).toHaveLength(0);
  });

  it("drops yesterday's digest even if it has real content", () => {
    const out = filterTodayDigests([yesterdayReal], now);
    expect(out).toHaveLength(0);
  });

  it("drops old digests", () => {
    const out = filterTodayDigests([oldReal], now);
    expect(out).toHaveLength(0);
  });

  it("returns only today's real digests from a mixed list", () => {
    const all = [todayReal, todayFiller, yesterdayReal, oldReal];
    const out = filterTodayDigests(all, now);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(todayReal);
  });

  it("uses Eastern time: UTC midnight+2h is still yesterday in Eastern", () => {
    // 2026-06-15T02:00:00Z → Eastern = 2026-06-14 (UTC-4 in summer)
    const earlyUtc = new Date("2026-06-15T02:00:00Z");
    const eastYesterday = digest({
      topic_slug: "ai_models",
      digest_date: "2026-06-14",
      content: "Real content.",
      items: null,
    });
    const eastToday = digest({
      topic_slug: "ai_models",
      digest_date: "2026-06-15",
      content: "This is the UTC date but not Eastern date.",
      items: null,
    });
    const out = filterTodayDigests([eastYesterday, eastToday], earlyUtc);
    // Eastern date is 2026-06-14 at this moment, so only eastYesterday should pass
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(eastYesterday);
  });

  it("returns empty array when given no digests", () => {
    expect(filterTodayDigests([], now)).toHaveLength(0);
  });
});
