// Shared data shapes. Mirrors the Supabase schema (docs/architecture.md §3.1).

/** One source reference attached to a digest item. */
export interface DigestItemSource {
  title: string;
  url: string;
}

/** One ranked item in a structured digest (issue #58). */
export interface DigestItem {
  headline: string;
  blurb: string;
  detail: string;
  metadata?: {
    sources?: DigestItemSource[];
    tags?: string[];
    /** Per-item sentiment (world_news topic, issue #19): one of
     *  "positive" | "negative" | "neutral" | "concerning".
     *  Typed as string because the value is LLM-generated — the renderer
     *  validates against the allowed set before displaying a badge. */
    sentiment?: string;
  };
}

export interface Digest {
  id: string;
  topic_slug: string;
  content: string;
  cadence: string;
  digest_date: string; // ISO date (YYYY-MM-DD)
  sources_used: unknown;
  token_count: number | null;
  prompt_version: string;
  created_at: string;
  /** Short top-level overview; null on pre-#58 rows. */
  summary: string | null;
  /** Ranked structured items; null on pre-#58 rows. */
  items: DigestItem[] | null;
}

export interface Topic {
  id: number;
  name: string;
  slug: string;
  cadence: string;
  enabled: boolean;
}

/**
 * One overdue topic from the v_missed_digests view (computed live from current
 * digest state, so it never goes stale once a digest publishes).
 */
export interface MissedDigest {
  topic_slug: string;
  cadence: string;
  last_digest_date: string | null; // ISO date, or null if never published
  window_hours: number;
}

/** One topic group, holding its digests bucketed by date (newest first). */
export interface TopicGroup {
  slug: string;
  name: string;
  dates: DateGroup[];
}

export interface DateGroup {
  date: string;
  digests: Digest[];
}

/** One topic bucket within a DateTopicGroup. */
export interface DateTopicBucket {
  slug: string;
  name: string;
  digests: Digest[];
}

/**
 * Date-first grouping: one entry per calendar date (newest date first), with
 * topics nested within each date. Used by History and Home views (issue #101).
 */
export interface DateTopicGroup {
  date: string;
  topics: DateTopicBucket[];
}

/** One row from the system_logs table (read-only, authenticated role). */
export interface SystemLog {
  id: string;
  timestamp: string;       // ISO timestamptz
  level: "info" | "warn" | "error";
  category: string;
  topic_slug: string | null;
  message: string;
  metadata: unknown;       // jsonb — may be null or any JSON value
  created_at: string;
}

// ── Observability views (issue #20) ──────────────────────────────────────────

/** One row from v_errors_per_day. */
export interface ErrorsPerDay {
  day: string;           // ISO date
  error_count: number;
}

/** One row from source_candidates (pending/approved/rejected). */
export interface SourceCandidate {
  id: string;
  topic_slug: string;
  url: string;
  type: string;
  replaces_url: string | null;
  failure_class: string | null;
  relevance_score: number | null;
  validation: Record<string, unknown> | null;
  status: string;
  created_at: string;
  decided_at: string | null;
}

/** One row from mv_source_health (also covers v_source_success_rate's subset). */
export interface SourceHealth {
  source_url: string;
  success_7d: number;
  failure_7d: number;
  total_7d: number;
  success_pct_7d: number | null;
  last_success_at: string | null;   // ISO timestamptz
  last_error_at: string | null;
  last_fetch_at: string | null;
  last_error: string | null;
  /** Most lenient configured cadence in hours (24 or 168); null if unknown.
   *  Drives the cadence-aware staleness rule (see lib/staleness.ts). */
  cadence_hours: number | null;
}

/** One row from v_run_duration. */
export interface RunDuration {
  topic_slug: string | null;
  model_id: string | null;
  run_count: number;
  avg_duration_s: number | null;
  avg_total_tokens: number | null;
  avg_input_tokens: number | null;
  avg_output_tokens: number | null;
  last_run_at: string | null;   // ISO timestamptz
}

/** One row from v_token_usage_by_day. */
export interface TokenUsageDay {
  day: string;            // ISO date
  topic_slug: string | null;
  model_id: string | null;
  run_count: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  total_duration_s: number;
}
