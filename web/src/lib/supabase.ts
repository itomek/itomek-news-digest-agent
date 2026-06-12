import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  digestsQuery,
  logsQuery,
  logsQueryExtended,
  topicsQuery,
  type LogsFilter,
  type LogsFilterExtended,
} from "./query";
import type {
  Digest,
  ErrorsPerDay,
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
  if (spec.search) q = q.ilike("message", `%${spec.search}%`);

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

/** Fetch recent missed-digest warnings (last N hours). */
export async function fetchMissedDigestWarnings(
  client: SupabaseClient,
  hours = 48,
): Promise<SystemLog[]> {
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const { data, error } = await client
    .from("system_logs")
    .select("id, timestamp, level, category, topic_slug, message, metadata, created_at")
    .eq("category", "schedule")
    .eq("level", "warn")
    .gte("timestamp", since)
    .order("timestamp", { ascending: false })
    .limit(20);
  if (error) throw error;
  // Filter client-side for the missed_digest tag so non-missed-digest schedule
  // warnings are excluded.
  const rows = (data ?? []) as unknown as SystemLog[];
  return rows.filter((r) => {
    const m = r.metadata as Record<string, unknown> | null;
    return m != null && m["missed_digest"] === true;
  });
}
