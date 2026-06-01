// Pure query-shape builders. Kept framework-agnostic and unit-tested so the
// supabase client wiring stays thin. #12 (history) can reuse these.

export interface QuerySpec {
  table: string;
  columns: string;
  order: { column: string; ascending: boolean };
  limit?: number;
}

const DIGEST_COLUMNS =
  "id, topic_slug, content, cadence, digest_date, sources_used, token_count, prompt_version, created_at";
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
