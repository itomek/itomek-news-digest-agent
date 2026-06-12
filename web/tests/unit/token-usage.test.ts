import { describe, expect, it } from "vitest";
import {
  allZeroTokens,
  formatDuration,
  formatTokens,
  groupByDay,
  primaryMetric,
  primaryMetricLabel,
} from "../../src/pages/token-usage";
import type { TokenUsageDay } from "../../src/lib/types";

function makeRow(overrides: Partial<TokenUsageDay> = {}): TokenUsageDay {
  return {
    day: "2026-06-10",
    topic_slug: "ai_models",
    model_id: "Gemma-4-E4B-it-GGUF",
    run_count: 1,
    total_tokens: 1000,
    input_tokens: 700,
    output_tokens: 300,
    total_duration_s: 12.5,
    ...overrides,
  };
}

// --- groupByDay ----------------------------------------------------------------

describe("groupByDay", () => {
  it("groups rows by day", () => {
    const rows = [
      makeRow({ day: "2026-06-10", topic_slug: "ai_models", total_tokens: 1000 }),
      makeRow({ day: "2026-06-10", topic_slug: "ai_updates", total_tokens: 500 }),
      makeRow({ day: "2026-06-09", topic_slug: "ai_models", total_tokens: 800 }),
    ];
    const groups = groupByDay(rows);
    expect(groups).toHaveLength(2);

    const june10 = groups.find((g) => g.day === "2026-06-10");
    expect(june10).toBeDefined();
    expect(june10!.rows).toHaveLength(2);
    expect(june10!.total_tokens).toBe(1500);

    const june9 = groups.find((g) => g.day === "2026-06-09");
    expect(june9).toBeDefined();
    expect(june9!.rows).toHaveLength(1);
    expect(june9!.total_tokens).toBe(800);
  });

  it("returns empty array for empty input", () => {
    expect(groupByDay([])).toHaveLength(0);
  });

  it("accumulates total_duration_s per group", () => {
    const rows = [
      makeRow({ day: "2026-06-10", total_duration_s: 10 }),
      makeRow({ day: "2026-06-10", total_duration_s: 5.5 }),
    ];
    const groups = groupByDay(rows);
    expect(groups[0]!.total_duration_s).toBeCloseTo(15.5);
  });

  it("treats null total_tokens as 0", () => {
    const rows = [makeRow({ day: "2026-06-10", total_tokens: 0 })];
    const groups = groupByDay(rows);
    expect(groups[0]!.total_tokens).toBe(0);
  });
});

// --- allZeroTokens ------------------------------------------------------------

describe("allZeroTokens", () => {
  it("returns true when all rows have 0 tokens", () => {
    const rows = [
      makeRow({ total_tokens: 0 }),
      makeRow({ total_tokens: 0 }),
    ];
    expect(allZeroTokens(rows)).toBe(true);
  });

  it("returns false when at least one row has tokens", () => {
    const rows = [
      makeRow({ total_tokens: 0 }),
      makeRow({ total_tokens: 100 }),
    ];
    expect(allZeroTokens(rows)).toBe(false);
  });

  it("returns true for empty array", () => {
    expect(allZeroTokens([])).toBe(true);
  });
});

// --- formatTokens ------------------------------------------------------------

describe("formatTokens", () => {
  it("returns '—' for 0", () => {
    expect(formatTokens(0)).toBe("—");
  });

  it("returns '—' for null", () => {
    expect(formatTokens(null)).toBe("—");
  });

  it("returns '—' for undefined", () => {
    expect(formatTokens(undefined)).toBe("—");
  });

  it("formats a positive number", () => {
    const result = formatTokens(1234);
    expect(result).toContain("tok");
    expect(result).toContain("1");
  });
});

// --- formatDuration ----------------------------------------------------------

describe("formatDuration", () => {
  it("returns '—' for 0", () => {
    expect(formatDuration(0)).toBe("—");
  });

  it("returns '—' for null", () => {
    expect(formatDuration(null)).toBe("—");
  });

  it("formats a positive value with one decimal and ' s'", () => {
    expect(formatDuration(12.567)).toBe("12.6 s");
    expect(formatDuration(5)).toBe("5.0 s");
  });
});

// --- primaryMetric -----------------------------------------------------------

describe("primaryMetric", () => {
  it("returns total_tokens when useTokens=true", () => {
    const row = makeRow({ total_tokens: 1000, total_duration_s: 5 });
    expect(primaryMetric(row, true)).toBe(1000);
  });

  it("returns total_duration_s when useTokens=false", () => {
    const row = makeRow({ total_tokens: 1000, total_duration_s: 5 });
    expect(primaryMetric(row, false)).toBe(5);
  });

  it("returns 0 for null tokens when useTokens=true", () => {
    const row = makeRow({ total_tokens: 0 });
    expect(primaryMetric(row, true)).toBe(0);
  });
});

// --- primaryMetricLabel ------------------------------------------------------

describe("primaryMetricLabel", () => {
  it("returns 'Tokens' when useTokens=true", () => {
    expect(primaryMetricLabel(true)).toBe("Tokens");
  });

  it("returns 'Duration (s)' when useTokens=false", () => {
    expect(primaryMetricLabel(false)).toBe("Duration (s)");
  });
});
