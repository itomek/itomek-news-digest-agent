import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  digestsQuery,
  escapeIlike,
  logsQuery,
  logsQueryExtended,
  topicsQuery,
  type LogsFilter,
  type LogsFilterExtended,
} from "./query";
import type {
  Digest,
  ErrorsPerDay,
  MissedDigest,
  RunDuration,
  SourceHealth,
  SystemLog,
  TokenUsageDay,
  Topic,
} from "./types";

// Browser client: anon/publishable key ONLY. All reads are RLS-gated.
// NEVER import or ship the service_role key here.

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

let cached: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (cached) return cached;
  if (!url || !anonKey) {
    throw new Error(
      "Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copy web/.env.example to web/.env.",
    );
  }
  cached = createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return cached;
}

export async function fetchDigests(client: SupabaseClient, limit?: number): Promise<Digest[]> {
  const spec = digestsQuery({ limit });
  let q = client.from(spec.table).select(spec.columns).order(spec.order.column, {
    ascending: spec.order.ascending,
  });
  if (spec.limit) q = q.limit(spec.limit);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as Digest[];
}

export async function fetchTopics(client: SupabaseClient): Promise<Topic[]> {
  const spec = topicsQuery();
  const { data, error } = await client
    .from(spec.table)
    .select(spec.columns)
    .order(spec.order.column, { ascending: spec.order.ascending });
  if (error) throw error;
  return (data ?? []) as unknown as Topic[];
}

// --- Extension point for #12 (history) -------------------------------------
// Append history-specific query functions BELOW this line. Do not modify the
// functions above; #11 and #12 must not collide on the same code. Example:
//   export async function fetchDigestsForTopic(client, slug, opts) { ... }
// ---------------------------------------------------------------------------

/**
 * Fetches the full digest history (newest first), reusing the shared digest query
 * shape. The dataset is tiny (~5 topics x 30 days = 150 rows), so the history view
 * does all filtering, searching and grouping client-side — no server-side FTS. A
 * generous default limit guards against unbounded growth without paging.
 */
export async function fetchAllDigests(
  client: SupabaseClient,
  limit = 1000,
): Promise<Digest[]> {
  return fetchDigests(client, limit);
}

// --- Logs (#27) -------------------------------------------------------------

export interface LogsPage {
  rows: SystemLog[];
  /** True if there is at least one more page after this one. */
  hasMore: boolean;
}

/**
 * Fetch one page of system_logs rows matching the given filter.
 * All filtering is server-side: the table can grow to 30+ days of entries,
 * so client-side filtering is not appropriate here (unlike digests).
 */
export async function fetchLogs(
  client: SupabaseClient,
  filter: LogsFilter,
): Promise<LogsPage> {
  const spec = logsQuery(filter);
  let q = client
    .from(spec.table)
    .select(spec.columns)
    .gte("timestamp", spec.filters.dateFrom)
    .lte("timestamp", spec.filters.dateTo)
    .order(spec.order.column, { ascending: spec.order.ascending })
    .range(spec.range.from, spec.range.to);

  if (spec.filters.level) q = q.eq("level", spec.filters.level);
  if (spec.filters.category) q = q.eq("category", spec.filters.category);
  if (spec.filters.topic_slug) q = q.eq("topic_slug", spec.filters.topic_slug);

  const { data, error } = await q;
  if (error) throw error;

  const rows = (data ?? []) as unknown as SystemLog[];
  // If we got a full page, there might be more.
  const hasMore = rows.length === spec.range.to - spec.range.from + 1;
  return { rows, hasMore };
}

/** Fetch one page of logs with optional message search (server-side ilike). */
export async function fetchLogsExtended(
  client: SupabaseClient,
  filter: LogsFilterExtended,
): Promise<LogsPage> {
  const spec = logsQueryExtended(filter);
  let q = client
    .from(spec.table)
    .select(spec.columns)
    .gte("timestamp", spec.filters.dateFrom)
    .lte("timestamp", spec.filters.dateTo)
    .order(spec.order.column, { ascending: spec.order.ascending })
    .range(spec.range.from, spec.range.to);

  if (spec.filters.level) q = q.eq("level", spec.filters.level);
  if (spec.filters.category) q = q.eq("category", spec.filters.category);
  if (spec.filters.topic_slug) q = q.eq("topic_slug", spec.filters.topic_slug);
  // Escape %/_ so the user's term matches literally inside the pattern.
  if (spec.search) q = q.ilike("message", `%${escapeIlike(spec.search)}%`);

  const { data, error } = await q;
  if (error) throw error;

  const rows = (data ?? []) as unknown as SystemLog[];
  const hasMore = rows.length === spec.range.to - spec.range.from + 1;
  return { rows, hasMore };
}

// ── Observability views (#20) ─────────────────────────────────────────────────

/** Fetch errors-per-day aggregate (last N days). */
export async function fetchErrorsPerDay(
  client: SupabaseClient,
  days = 30,
): Promise<ErrorsPerDay[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data, error } = await client
    .from("v_errors_per_day")
    .select("day, error_count")
    .gte("day", since.slice(0, 10))
    .order("day", { ascending: false })
    .limit(days);
  if (error) throw error;
  return (data ?? []) as unknown as ErrorsPerDay[];
}

/** Fetch source health rows from the materialized view. */
export async function fetchSourceHealth(
  client: SupabaseClient,
): Promise<SourceHealth[]> {
  const { data, error } = await client
    .from("mv_source_health")
    .select(
      "source_url, success_7d, failure_7d, total_7d, success_pct_7d, last_success_at, last_error_at, last_fetch_at, last_error",
    )
    .order("source_url", { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as SourceHealth[];
}

/** Fetch average run duration per topic + model (all-time summarize rows). */
export async function fetchRunDurations(
  client: SupabaseClient,
): Promise<RunDuration[]> {
  const { data, error } = await client
    .from("v_run_duration")
    .select(
      "topic_slug, model_id, run_count, avg_duration_s, avg_total_tokens, avg_input_tokens, avg_output_tokens, last_run_at",
    )
    .order("last_run_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as unknown as RunDuration[];
}

/** Fetch token usage rows grouped by day + topic + model. */
export async function fetchTokenUsage(
  client: SupabaseClient,
  days = 30,
): Promise<TokenUsageDay[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const { data, error } = await client
    .from("v_token_usage_by_day")
    .select("day, topic_slug, model_id, run_count, total_tokens, input_tokens, output_tokens, total_duration_s")
    .gte("day", since)
    .order("day", { ascending: false })
    .limit(days * 10); // up to 10 topic+model combos per day
  if (error) throw error;
  return (data ?? []) as unknown as TokenUsageDay[];
}

/**
 * Fetch topics whose digest is currently overdue, computed live from the
 * v_missed_digests view. Unlike the old log-based read, this reflects current
 * state — a topic drops off the moment it publishes, so the banner never goes
 * stale.
 */
export async function fetchMissedDigests(
  client: SupabaseClient,
): Promise<MissedDigest[]> {
  const { data, error } = await client
    .from("v_missed_digests")
    .select("topic_slug, cadence, last_digest_date, window_hours")
    .order("topic_slug", { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as MissedDigest[];
}
