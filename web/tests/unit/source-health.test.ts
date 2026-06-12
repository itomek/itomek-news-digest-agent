import { describe, expect, it } from "vitest";
import {
  candidateWhy,
  formatPct,
  formatRelativeTime,
  formatRelevance,
  isSourceStale,
  partitionByHealth,
  STALE_LAST_SUCCESS_HOURS,
  STALE_SUCCESS_PCT_THRESHOLD,
} from "../../src/pages/source-health";
import type { SourceCandidate, SourceHealth } from "../../src/lib/types";

function makeRow(overrides: Partial<SourceHealth> = {}): SourceHealth {
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
    ...overrides,
  };
}

// --- isSourceStale -----------------------------------------------------------

describe("isSourceStale", () => {
  it("returns false for a fully healthy source", () => {
    expect(isSourceStale(makeRow())).toBe(false);
  });

  it("returns true when success_pct_7d is below threshold", () => {
    const row = makeRow({ success_pct_7d: STALE_SUCCESS_PCT_THRESHOLD - 1 });
    expect(isSourceStale(row)).toBe(true);
  });

  it("returns false at exactly the threshold", () => {
    const row = makeRow({ success_pct_7d: STALE_SUCCESS_PCT_THRESHOLD });
    // threshold is strictly < 50, so 50 is NOT stale (assuming recent success)
    expect(isSourceStale(row)).toBe(false);
  });

  it("returns true when last_success_at is null", () => {
    const row = makeRow({ last_success_at: null });
    expect(isSourceStale(row)).toBe(true);
  });

  it("returns true when last_success_at is older than 72h", () => {
    const oldDate = new Date(
      Date.now() - (STALE_LAST_SUCCESS_HOURS + 1) * 3_600_000,
    ).toISOString();
    const row = makeRow({ last_success_at: oldDate });
    expect(isSourceStale(row)).toBe(true);
  });

  it("returns false when last_success_at is within 72h", () => {
    const recentDate = new Date(
      Date.now() - (STALE_LAST_SUCCESS_HOURS - 1) * 3_600_000,
    ).toISOString();
    const row = makeRow({ last_success_at: recentDate });
    expect(isSourceStale(row)).toBe(false);
  });

  it("returns true when success_pct is null (treated as stale)", () => {
    // null success_pct_7d does not trigger lowRate, but a null last_success_at
    // triggers noRecentSuccess — test both together
    const row = makeRow({ success_pct_7d: null, last_success_at: null });
    expect(isSourceStale(row)).toBe(true);
  });

  it("is stale if either condition holds", () => {
    // Low rate but recent success
    const lowRate = makeRow({
      success_pct_7d: 10,
      last_success_at: new Date().toISOString(),
    });
    expect(isSourceStale(lowRate)).toBe(true);

    // Good rate but old success
    const oldSuccess = makeRow({
      success_pct_7d: 100,
      last_success_at: new Date(Date.now() - 100 * 3_600_000).toISOString(),
    });
    expect(isSourceStale(oldSuccess)).toBe(true);
  });
});

// --- formatPct ---------------------------------------------------------------

describe("formatPct", () => {
  it("formats a number with one decimal", () => {
    expect(formatPct(95.678)).toBe("95.7%");
    expect(formatPct(0)).toBe("0.0%");
    expect(formatPct(100)).toBe("100.0%");
  });

  it("returns 'N/A' for null", () => {
    expect(formatPct(null)).toBe("N/A");
  });
});

// --- formatRelativeTime -------------------------------------------------------

describe("formatRelativeTime", () => {
  it("returns 'Never' for null", () => {
    expect(formatRelativeTime(null)).toBe("Never");
  });

  it("returns Xm ago for times < 1 hour ago", () => {
    const thirtyMinAgo = new Date(Date.now() - 30 * 60_000).toISOString();
    expect(formatRelativeTime(thirtyMinAgo)).toMatch(/^\d+m ago$/);
  });

  it("returns Xh ago for times 1–47 hours ago", () => {
    const sixHoursAgo = new Date(Date.now() - 6 * 3_600_000).toISOString();
    expect(formatRelativeTime(sixHoursAgo)).toMatch(/^\d+h ago$/);
  });

  it("returns Xd ago for times 48+ hours ago", () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
    expect(formatRelativeTime(threeDaysAgo)).toMatch(/^\d+d ago$/);
  });
});

// --- partitionByHealth -------------------------------------------------------

describe("partitionByHealth", () => {
  it("partitions correctly", () => {
    const healthy = makeRow({ success_pct_7d: 100 });
    const stale = makeRow({
      source_url: "https://stale.example",
      success_pct_7d: 10,
    });
    const result = partitionByHealth([healthy, stale]);
    expect(result.healthy).toHaveLength(1);
    expect(result.stale).toHaveLength(1);
    expect(result.healthy[0]?.source_url).toBe("https://example.com/feed");
    expect(result.stale[0]?.source_url).toBe("https://stale.example");
  });

  it("returns empty arrays for empty input", () => {
    const result = partitionByHealth([]);
    expect(result.healthy).toHaveLength(0);
    expect(result.stale).toHaveLength(0);
  });

  it("puts all-healthy rows in healthy only", () => {
    const rows = [makeRow(), makeRow({ source_url: "https://b.example/feed" })];
    const result = partitionByHealth(rows);
    expect(result.stale).toHaveLength(0);
    expect(result.healthy).toHaveLength(2);
  });
});

// --- constants ----------------------------------------------------------------

describe("staleness thresholds", () => {
  it("STALE_SUCCESS_PCT_THRESHOLD is 50", () => {
    expect(STALE_SUCCESS_PCT_THRESHOLD).toBe(50);
  });

  it("STALE_LAST_SUCCESS_HOURS is 72", () => {
    expect(STALE_LAST_SUCCESS_HOURS).toBe(72);
  });
});

// --- formatRelevance ----------------------------------------------------------

function makeCandidate(overrides: Partial<SourceCandidate> = {}): SourceCandidate {
  return {
    id: "cand-001",
    topic_slug: "ai_models",
    url: "https://new.example.com/rss",
    type: "rss",
    replaces_url: "https://old.example.com/feed",
    failure_class: "blocked",
    relevance_score: 0.85,
    validation: { fetch_ok: true, item_count: 5, parseable: true, recent: true },
    status: "pending",
    created_at: "2026-06-12T04:00:00Z",
    decided_at: null,
    ...overrides,
  };
}

describe("formatRelevance", () => {
  it("formats a score as rounded percent", () => {
    expect(formatRelevance(0.85)).toBe("85%");
    expect(formatRelevance(0.0)).toBe("0%");
    expect(formatRelevance(1.0)).toBe("100%");
    expect(formatRelevance(0.571)).toBe("57%");
  });

  it("returns N/A for null", () => {
    expect(formatRelevance(null)).toBe("N/A");
  });
});

// --- candidateWhy -------------------------------------------------------------

describe("candidateWhy", () => {
  it("returns dead message for dead failure class", () => {
    const cand = makeCandidate({ failure_class: "dead" });
    expect(candidateWhy(cand)).toContain("dead");
  });

  it("returns blocked message for blocked failure class", () => {
    const cand = makeCandidate({ failure_class: "blocked" });
    expect(candidateWhy(cand)).toContain("blocked");
  });

  it("returns item count when validation has item_count", () => {
    const cand = makeCandidate({
      failure_class: null,
      validation: { item_count: 7 },
    });
    const why = candidateWhy(cand);
    expect(why).toContain("7");
  });

  it("returns fallback for null failure_class and no validation", () => {
    const cand = makeCandidate({ failure_class: null, validation: null });
    expect(candidateWhy(cand)).toContain("web search");
  });
});

// --- approveSourceCandidate / rejectSourceCandidate error mapping -------------

import {
  approveSourceCandidate,
  rejectSourceCandidate,
} from "../../src/lib/supabase";

describe("approveSourceCandidate", () => {
  it("returns null on success", async () => {
    const client = { rpc: async () => ({ error: null }) } as never;
    const result = await approveSourceCandidate(client, "cand-001");
    expect(result).toBeNull();
  });

  it("returns error message string on failure", async () => {
    const client = {
      rpc: async () => ({ error: { message: "candidate not pending" } }),
    } as never;
    const result = await approveSourceCandidate(client, "cand-001");
    expect(result).toBe("candidate not pending");
  });
});

describe("rejectSourceCandidate", () => {
  it("returns null on success", async () => {
    const client = { rpc: async () => ({ error: null }) } as never;
    const result = await rejectSourceCandidate(client, "cand-001");
    expect(result).toBeNull();
  });

  it("returns error message string on failure", async () => {
    const client = {
      rpc: async () => ({ error: { message: "not found or not pending" } }),
    } as never;
    const result = await rejectSourceCandidate(client, "cand-001");
    expect(result).toBe("not found or not pending");
  });
});
