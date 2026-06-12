// Pure query-shape builders. Kept framework-agnostic and unit-tested so the
// supabase client wiring stays thin. #12 (history) can reuse these.

export interface QuerySpec {
  table: string;
  columns: string;
  order: { column: string; ascending: boolean };
  limit?: number;
}

const DIGEST_COLUMNS =
  "id, topic_slug, content, summary, items, cadence, digest_date, sources_used, token_count, prompt_version, created_at";
const TOPIC_COLUMNS = "id, name, slug, cadence, enabled";

export function digestsQuery(opts: { limit?: number } = {}): QuerySpec {
  return {
    table: "digests",
    columns: DIGEST_COLUMNS,
    order: { column: "digest_date", ascending: false },
    limit: opts.limit,
  };
}

export function topicsQuery(): QuerySpec {
  return {
    table: "digest_topics",
    columns: TOPIC_COLUMNS,
    order: { column: "slug", ascending: true },
  };
}

// --- Logs query (#27) --------------------------------------------------------

export type LogLevel = "info" | "warn" | "error";

export const LOG_PAGE_SIZE = 100;

const LOG_COLUMNS = "id, timestamp, level, category, topic_slug, message, metadata, created_at";

export interface LogsFilter {
  /** ISO datetime string — inclusive lower bound on `timestamp`. */
  dateFrom: string;
  /** ISO datetime string — inclusive upper bound on `timestamp`. */
  dateTo: string;
  level: LogLevel | null;
  category: string;
  topic_slug: string;
  page: number;
}

export interface LogsQuerySpec {
  table: string;
  columns: string;
  filters: {
    dateFrom: string;
    dateTo: string;
    level: LogLevel | null;
    category: string | null;
    topic_slug: string | null;
  };
  order: { column: string; ascending: boolean };
  range: { from: number; to: number };
}

/** Build a server-side query spec for the logs page — pure, testable, no client import. */
export function logsQuery(f: LogsFilter): LogsQuerySpec {
  const from = f.page * LOG_PAGE_SIZE;
  const to = from + LOG_PAGE_SIZE - 1;
  return {
    table: "system_logs",
    columns: LOG_COLUMNS,
    filters: {
      dateFrom: f.dateFrom,
      dateTo: f.dateTo,
      level: f.level || null,
      category: f.category.trim() || null,
      topic_slug: f.topic_slug.trim() || null,
    },
    order: { column: "timestamp", ascending: false },
    range: { from, to },
  };
}

/** Default date-range: last 24 hours. */
export function defaultLogsFilter(): LogsFilter {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return {
    dateFrom: yesterday.toISOString(),
    dateTo: now.toISOString(),
    level: null,
    category: "",
    topic_slug: "",
    page: 0,
  };
}
