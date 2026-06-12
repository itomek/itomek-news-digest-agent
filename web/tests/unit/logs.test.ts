import { describe, expect, it } from "vitest";
import {
  FALLBACK_TOPIC_SLUGS,
  formatTimestamp,
  fromDatetimeLocal,
  levelClass,
  LOG_CATEGORIES,
  pagerLabel,
  parseLogsState,
  prettyMetadata,
  serializeLogsState,
  toDatetimeLocal,
  type LogsState,
} from "../../src/pages/logs";
import {
  defaultLogsFilter,
  LOG_PAGE_SIZE,
  logsQuery,
  type LogsFilter,
} from "../../src/lib/query";

// --- parseLogsState / serializeLogsState ------------------------------------

describe("parseLogsState", () => {
  it("returns defaults when no params present", () => {
    const state = parseLogsState("");
    expect(state.level).toBeNull();
    expect(state.category).toBe("");
    expect(state.topic_slug).toBe("");
    expect(state.page).toBe(0);
    // dateFrom / dateTo should be non-empty strings (ISO datetimes)
    expect(state.dateFrom).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(state.dateTo).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("parses level, category, topic_slug, page", () => {
    const state = parseLogsState("?level=error&category=scraper&topic_slug=ai_models&page=3");
    expect(state.level).toBe("error");
    expect(state.category).toBe("scraper");
    expect(state.topic_slug).toBe("ai_models");
    expect(state.page).toBe(3);
  });

  it("rejects invalid level values", () => {
    const state = parseLogsState("?level=debug");
    expect(state.level).toBeNull();
  });

  it("clamps page to 0 for negative / non-numeric values", () => {
    expect(parseLogsState("?page=-5").page).toBe(0);
    expect(parseLogsState("?page=abc").page).toBe(0);
  });

  it("parses all three valid log levels", () => {
    expect(parseLogsState("?level=info").level).toBe("info");
    expect(parseLogsState("?level=warn").level).toBe("warn");
    expect(parseLogsState("?level=error").level).toBe("error");
  });
});

describe("serializeLogsState", () => {
  // Use fixed ISO strings so tests are deterministic (dateFrom/dateTo always emitted)
  const fixedState: LogsState = {
    dateFrom: "2026-06-01T00:00:00.000Z",
    dateTo: "2026-06-02T00:00:00.000Z",
    level: null,
    category: "",
    topic_slug: "",
    page: 0,
  };

  it("always emits dateFrom and dateTo", () => {
    const s = serializeLogsState(fixedState);
    expect(s).toContain("dateFrom=");
    expect(s).toContain("dateTo=");
  });

  it("includes level when set", () => {
    const s = serializeLogsState({ ...fixedState, level: "warn" });
    expect(s).toContain("level=warn");
  });

  it("omits level when null", () => {
    expect(serializeLogsState(fixedState)).not.toContain("level=");
  });

  it("includes category when non-empty", () => {
    const s = serializeLogsState({ ...fixedState, category: "publisher" });
    expect(s).toContain("category=publisher");
  });

  it("omits category when blank", () => {
    expect(serializeLogsState({ ...fixedState, category: "  " })).not.toContain("category=");
  });

  it("includes topic_slug when non-empty", () => {
    const s = serializeLogsState({ ...fixedState, topic_slug: "penguins" });
    expect(s).toContain("topic_slug=penguins");
  });

  it("includes page when > 0", () => {
    const s = serializeLogsState({ ...fixedState, page: 2 });
    expect(s).toContain("page=2");
  });

  it("omits page when 0", () => {
    expect(serializeLogsState(fixedState)).not.toContain("page=");
  });

  it("round-trips through serialize -> parse", () => {
    const state: LogsState = {
      dateFrom: "2026-06-01T00:00:00.000Z",
      dateTo: "2026-06-10T23:59:59.000Z",
      level: "error",
      category: "scraper",
      topic_slug: "ai_models",
      page: 4,
    };
    const parsed = parseLogsState(serializeLogsState(state));
    expect(parsed.dateFrom).toBe(state.dateFrom);
    expect(parsed.dateTo).toBe(state.dateTo);
    expect(parsed.level).toBe(state.level);
    expect(parsed.category).toBe(state.category);
    expect(parsed.topic_slug).toBe(state.topic_slug);
    expect(parsed.page).toBe(state.page);
  });
});

// --- levelClass -------------------------------------------------------------

describe("levelClass", () => {
  it("returns error class for error level", () => {
    expect(levelClass("error")).toContain("log-level--error");
  });

  it("returns warn class for warn level", () => {
    expect(levelClass("warn")).toContain("log-level--warn");
  });

  it("returns info class for info level (and any unknown level)", () => {
    expect(levelClass("info")).toContain("log-level--info");
    expect(levelClass("debug")).toContain("log-level--info");
  });

  it("always includes the base log-level class", () => {
    for (const l of ["info", "warn", "error"]) {
      expect(levelClass(l)).toContain("log-level");
    }
  });
});

// --- formatTimestamp ---------------------------------------------------------

describe("formatTimestamp", () => {
  it("returns a non-empty string for a valid ISO timestamp", () => {
    const result = formatTimestamp("2026-06-01T12:30:00.000Z");
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns the original string when parsing fails", () => {
    expect(formatTimestamp("not-a-date")).toBe("not-a-date");
  });
});

// --- prettyMetadata ----------------------------------------------------------

describe("prettyMetadata", () => {
  it("returns '—' for null", () => {
    expect(prettyMetadata(null)).toBe("—");
  });

  it("returns '—' for undefined", () => {
    expect(prettyMetadata(undefined)).toBe("—");
  });

  it("returns a pretty-printed JSON string for an object", () => {
    const result = prettyMetadata({ key: "value", n: 42 });
    expect(result).toContain('"key"');
    expect(result).toContain('"value"');
    expect(result).toContain("42");
  });

  it("pretty-prints arrays", () => {
    const result = prettyMetadata([1, 2, 3]);
    expect(result).toContain("1");
    expect(result).toContain("2");
  });
});

// --- logsQuery --------------------------------------------------------------

describe("logsQuery", () => {
  const base: LogsFilter = {
    dateFrom: "2026-06-01T00:00:00.000Z",
    dateTo: "2026-06-10T23:59:59.000Z",
    level: null,
    category: "",
    topic_slug: "",
    page: 0,
  };

  it("targets the system_logs table", () => {
    expect(logsQuery(base).table).toBe("system_logs");
  });

  it("selects expected columns", () => {
    const q = logsQuery(base);
    expect(q.columns).toContain("id");
    expect(q.columns).toContain("timestamp");
    expect(q.columns).toContain("level");
    expect(q.columns).toContain("category");
    expect(q.columns).toContain("topic_slug");
    expect(q.columns).toContain("message");
    expect(q.columns).toContain("metadata");
  });

  it("orders by timestamp descending", () => {
    const q = logsQuery(base);
    expect(q.order.column).toBe("timestamp");
    expect(q.order.ascending).toBe(false);
  });

  it("page 0 maps to range 0–99", () => {
    expect(logsQuery(base).range).toEqual({ from: 0, to: LOG_PAGE_SIZE - 1 });
  });

  it("page 1 maps to range 100–199", () => {
    expect(logsQuery({ ...base, page: 1 }).range).toEqual({
      from: LOG_PAGE_SIZE,
      to: 2 * LOG_PAGE_SIZE - 1,
    });
  });

  it("passes dateFrom / dateTo through filters", () => {
    const q = logsQuery(base);
    expect(q.filters.dateFrom).toBe(base.dateFrom);
    expect(q.filters.dateTo).toBe(base.dateTo);
  });

  it("converts empty level to null in filters", () => {
    expect(logsQuery({ ...base, level: null }).filters.level).toBeNull();
  });

  it("keeps non-null level in filters", () => {
    expect(logsQuery({ ...base, level: "warn" }).filters.level).toBe("warn");
  });

  it("converts blank category to null in filters", () => {
    expect(logsQuery({ ...base, category: "  " }).filters.category).toBeNull();
  });

  it("trims and keeps non-blank category", () => {
    expect(logsQuery({ ...base, category: " scraper " }).filters.category).toBe("scraper");
  });

  it("converts blank topic_slug to null in filters", () => {
    expect(logsQuery({ ...base, topic_slug: "" }).filters.topic_slug).toBeNull();
  });

  it("trims and keeps non-blank topic_slug", () => {
    expect(logsQuery({ ...base, topic_slug: " ai_models " }).filters.topic_slug).toBe("ai_models");
  });
});

// --- defaultLogsFilter ------------------------------------------------------

describe("defaultLogsFilter", () => {
  it("defaults to page 0", () => {
    expect(defaultLogsFilter().page).toBe(0);
  });

  it("dateTo is later than dateFrom", () => {
    const f = defaultLogsFilter();
    expect(new Date(f.dateTo).getTime()).toBeGreaterThan(new Date(f.dateFrom).getTime());
  });

  it("date window is approximately 24 hours", () => {
    const f = defaultLogsFilter();
    const diffMs = new Date(f.dateTo).getTime() - new Date(f.dateFrom).getTime();
    const diffHours = diffMs / (1000 * 60 * 60);
    expect(diffHours).toBeCloseTo(24, 0);
  });

  it("defaults to null level / empty category / empty topic_slug", () => {
    const f = defaultLogsFilter();
    expect(f.level).toBeNull();
    expect(f.category).toBe("");
    expect(f.topic_slug).toBe("");
  });
});

// --- LOG_CATEGORIES / FALLBACK_TOPIC_SLUGS (select option sources) ------------

describe("LOG_CATEGORIES", () => {
  it("matches the agent's canonical Category literals (src/news_digest/logging.py)", () => {
    expect([...LOG_CATEGORIES]).toEqual([
      "schedule",
      "scrape",
      "summarize",
      "publish",
      "feedback",
      "hello_world",
      "system",
    ]);
  });

  it("contains no duplicates or blanks", () => {
    expect(new Set(LOG_CATEGORIES).size).toBe(LOG_CATEGORIES.length);
    expect(LOG_CATEGORIES.every((c) => c.trim().length > 0)).toBe(true);
  });
});

describe("FALLBACK_TOPIC_SLUGS", () => {
  it("covers the five known digest topics", () => {
    expect([...FALLBACK_TOPIC_SLUGS].sort()).toEqual([
      "ai_models",
      "ai_updates",
      "local_news",
      "penguins",
      "world_news",
    ]);
  });
});

// --- toDatetimeLocal / fromDatetimeLocal --------------------------------------

describe("toDatetimeLocal", () => {
  it("formats a valid ISO string as YYYY-MM-DDTHH:MM", () => {
    expect(toDatetimeLocal("2026-06-01T12:30:00.000Z")).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/,
    );
  });

  it("returns empty string for unparseable input (no NaN-NaN-NaN output)", () => {
    expect(toDatetimeLocal("not-a-date")).toBe("");
    expect(toDatetimeLocal("")).toBe("");
  });
});

describe("fromDatetimeLocal", () => {
  it("converts a datetime-local value to an ISO string", () => {
    const iso = fromDatetimeLocal("2026-06-01T12:30");
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(Number.isNaN(new Date(iso).getTime())).toBe(false);
  });

  it("returns empty string for empty or unparseable input", () => {
    expect(fromDatetimeLocal("")).toBe("");
    expect(fromDatetimeLocal("garbage")).toBe("");
  });

  it("round-trips with toDatetimeLocal to the same minute", () => {
    const local = "2026-06-01T12:30";
    expect(toDatetimeLocal(fromDatetimeLocal(local))).toBe(local);
  });
});

// --- pagerLabel ----------------------------------------------------------------

describe("pagerLabel", () => {
  it("shows 'No rows' for an empty page", () => {
    expect(pagerLabel(0, 0)).toBe("No rows");
    expect(pagerLabel(3, 0)).toBe("No rows");
  });

  it("shows the actual row range on page 0", () => {
    expect(pagerLabel(0, 100)).toBe("Rows 1–100");
    expect(pagerLabel(0, 7)).toBe("Rows 1–7");
  });

  it("offsets the range by the page number", () => {
    expect(pagerLabel(1, 100)).toBe("Rows 101–200");
    expect(pagerLabel(2, 42)).toBe("Rows 201–242");
  });
});
