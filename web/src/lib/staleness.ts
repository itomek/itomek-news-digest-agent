// Shared, cadence-aware source-staleness rule (issue #123).
//
// A single source of truth used by BOTH the Source Health page
// (`pages/source-health.ts`) and the Logs "Aggregations" tab
// (`pages/logs.ts`), so the two surfaces can never disagree.
//
// A source is STALE when ANY of:
//   1. success_pct_7d is known and below 50% (more failures than successes), OR
//   2. it has never had a successful fetch (last_success_at is null), OR
//   3. its last success is older than the cadence-aware deadline:
//        effHours + STALE_SUCCESS_GRACE_HOURS
//      where effHours is the source's configured cadence (cadence_hours) when
//      known and positive, else the 24h default. The grace window keeps a feed
//      from flapping to "stale" the moment it's one cycle late.
//
// Examples (grace = 48h):
//   24h cadence → deadline 72h  (preserves the pre-#123 behavior)
//    7d cadence → deadline 216h (a healthy weekly feed isn't falsely flagged)
//   unknown     → deadline 72h  (falls back to the 24h default)

import type { SourceHealth } from "./types";

/** Below this 7-day success percentage, a source is stale. */
export const STALE_SUCCESS_PCT_THRESHOLD = 50;

/** Hours of grace added on top of a source's cadence before it's "stale". */
export const STALE_SUCCESS_GRACE_HOURS = 48;

/** Default cadence (hours) when a source has no known cadence_hours. */
const DEFAULT_CADENCE_HOURS = 24;

/**
 * Last-success deadline (hours) for a 24h-cadence / unknown-cadence source.
 * Equals DEFAULT_CADENCE_HOURS + STALE_SUCCESS_GRACE_HOURS = 72, matching the
 * pre-#123 fixed threshold. Kept as a named export for tests and callers.
 */
export const STALE_LAST_SUCCESS_HOURS =
  DEFAULT_CADENCE_HOURS + STALE_SUCCESS_GRACE_HOURS;

/**
 * Cadence-aware last-success deadline (hours) for one source.
 * Uses the configured cadence when known and positive, else the 24h default,
 * plus the shared grace window.
 */
export function staleAfterHours(cadenceHours: number | null | undefined): number {
  const effHours =
    typeof cadenceHours === "number" && cadenceHours > 0
      ? cadenceHours
      : DEFAULT_CADENCE_HOURS;
  return effHours + STALE_SUCCESS_GRACE_HOURS;
}

/** Return true when a source is considered stale per the cadence-aware rules. */
export function isSourceStale(row: SourceHealth): boolean {
  const lowRate =
    row.success_pct_7d !== null &&
    row.success_pct_7d < STALE_SUCCESS_PCT_THRESHOLD;
  if (lowRate) return true;

  if (row.last_success_at === null) return true;

  const ageHours =
    (Date.now() - new Date(row.last_success_at).getTime()) / 3_600_000;
  return ageHours > staleAfterHours(row.cadence_hours);
}
