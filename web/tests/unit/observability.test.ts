import { describe, expect, it } from "vitest";
import {
  formatAvgDuration,
  formatSuccessPct,
  parseLogsState,
  serializeLogsState,
  type LogsState,
} from "../../src/pages/logs";
import { isSourceStale } from "../../src/lib/staleness";
import {
  defaultLogsFilterExtended,
  escapeIlike,
  logsQueryExtended,
  type LogsFilterExtended,
} from "../../src/lib/query";
import type { SourceHealth } from "../../src/lib/types";

function makeHealthRow(
  overrides: Partial<SourceHealth & { cadence_hours: number | null }> = {},
): SourceHealth & { cadence_hours: number | null } {
  return {
    source_url: "https://example.com/feed",
    success_7d: 10,
    failure_7d: 0,
    total_7d: 10,
    success_pct_7d: 100,
    last_success_at: new Date().toISOString(),
    last_error_at: null,
    last_fetch_at: new Date().toISOString(),
    last_error: null,
    cadence_hours: null,
    ...overrides,
  };
}

// --- parseLogsState / serializeLogsState with search field -------------------

describe("parseLogsState (search field)", () => {
  it("defaults search to empty string", () => {
    expect(parseLogsState("").search).toBe("");
  });

  it("parses search from URL", () => {
    expect(parseLogsState("?search=timeout").search).toBe("timeout");
  });

  it("round-trips search through serialize -> parse", () => {
    const state: LogsState = {
      dateFrom: "2026-06-01T00:00:00.000Z",
      dateTo: "2026-06-10T23:59:59.000Z",
      level: null,
      category: "",
      topic_slug: "",
      search: "timeout error",
      page: 0,
    };
    const parsed = parseLogsState(serializeLogsState(state));
    expect(parsed.search).toBe("timeout error");
  });

  it("omits search from serialized URL when blank", () => {
    const state: LogsState = {
      dateFrom: "2026-06-01T00:00:00.000Z",
      dateTo: "2026-06-02T00:00:00.000Z",
      level: null,
      category: "",
      topic_slug: "",
      search: "  ",
      page: 0,
    };
    expect(serializeLogsState(state)).not.toContain("search=");
  });
});

// --- logsQueryExtended -------------------------------------------------------

describe("logsQueryExtended", () => {
  const base: LogsFilterExtended = {
    dateFrom: "2026-06-01T00:00:00.000Z",
    dateTo: "2026-06-10T23:59:59.000Z",
    level: null,
    category: "",
    topic_slug: "",
    search: "",
    page: 0,
  };

  it("returns null search when search is empty", () => {
    expect(logsQueryExtended(base).search).toBeNull();
  });

  it("returns null search when search is whitespace", () => {
    expect(logsQueryExtended({ ...base, search: "   " }).search).toBeNull();
  });

  it("returns trimmed search when non-empty", () => {
    expect(logsQueryExtended({ ...base, search: " timeout " }).search).toBe("timeout");
  });

  it("inherits all logsQuery fields", () => {
    const spec = logsQueryExtended(base);
    expect(spec.table).toBe("system_logs");
    expect(spec.order.column).toBe("timestamp");
  });
});

// --- defaultLogsFilterExtended -----------------------------------------------

describe("defaultLogsFilterExtended", () => {
  it("includes search field defaulting to empty", () => {
    const f = defaultLogsFilterExtended();
    expect(f.search).toBe("");
  });

  it("inherits defaultLogsFilter fields", () => {
    const f = defaultLogsFilterExtended();
    expect(f.level).toBeNull();
    expect(f.page).toBe(0);
  });
});

// --- isSourceStale (from logs.ts helpers) ------------------------------------

describe("isSourceStale (logs.ts re-export)", () => {
  it("returns false for healthy source", () => {
    expect(isSourceStale(makeHealthRow())).toBe(false);
  });

  it("returns true for low success rate", () => {
    expect(isSourceStale(makeHealthRow({ success_pct_7d: 20 }))).toBe(true);
  });

  it("returns true for null last_success_at", () => {
    expect(isSourceStale(makeHealthRow({ last_success_at: null }))).toBe(true);
  });
});

// --- formatSuccessPct --------------------------------------------------------

describe("formatSuccessPct", () => {
  it("formats a percentage with one decimal", () => {
    expect(formatSuccessPct(95.6)).toBe("95.6%");
    expect(formatSuccessPct(0)).toBe("0.0%");
    expect(formatSuccessPct(100)).toBe("100.0%");
  });

  it("returns 'N/A' for null", () => {
    expect(formatSuccessPct(null)).toBe("N/A");
  });
});

// --- formatAvgDuration -------------------------------------------------------

describe("formatAvgDuration", () => {
  it("formats a duration with one decimal and ' s'", () => {
    expect(formatAvgDuration(12.34)).toBe("12.3 s");
    expect(formatAvgDuration(5)).toBe("5.0 s");
  });

  it("returns '—' for null and zero", () => {
    expect(formatAvgDuration(null)).toBe("—");
    expect(formatAvgDuration(0)).toBe("—");
  });
});

// --- escapeIlike ---------------------------------------------------------------

describe("escapeIlike", () => {
  it("escapes percent signs", () => {
    expect(escapeIlike("100%")).toBe("100\\%");
  });

  it("escapes underscores", () => {
    expect(escapeIlike("topic_slug")).toBe("topic\\_slug");
  });

  it("escapes backslashes (the escape character itself)", () => {
    expect(escapeIlike("a\\b")).toBe("a\\\\b");
  });

  it("leaves plain terms untouched", () => {
    expect(escapeIlike("fetch rss timeout")).toBe("fetch rss timeout");
  });

  it("handles a mix of all metacharacters", () => {
    expect(escapeIlike("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
  });

  it("returns empty string for empty input", () => {
    expect(escapeIlike("")).toBe("");
  });
});
