// Date utilities for the News Digest app.
// All "today" comparisons use America/New_York — the agent runs on Eastern time,
// so that is the canonical date boundary for digest publication.

export const APP_TIMEZONE = "America/New_York";

/**
 * Return today's calendar date as a YYYY-MM-DD string in America/New_York.
 * Accepts an optional `now` for testability; defaults to the current instant.
 */
export function appToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: APP_TIMEZONE }).format(now);
}

/**
 * Return true if `digestDate` (YYYY-MM-DD) matches today in America/New_York.
 * Accepts an optional `now` for testability.
 */
export function isToday(digestDate: string, now: Date = new Date()): boolean {
  return digestDate === appToday(now);
}
