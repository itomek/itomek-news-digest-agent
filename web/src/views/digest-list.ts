import { groupDigestsByDateAndTopic } from "../lib/group";
import type { Digest, Topic } from "../lib/types";
import { renderDigestCard } from "./digest-card";

// timeZone: "UTC" is required. digest_date is a calendar date (YYYY-MM-DD) with
// no time-of-day or zone meaning. We build the Date at UTC midnight, so we must
// also format it in UTC — otherwise Intl renders it in the viewer's local zone
// and any viewer west of UTC sees the heading shift back a day (e.g. 2026-06-12
// displayed as "Thu, Jun 11" in US Eastern). Must match the raw digest_date the
// History view prints.
const dateFmt = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/** Format a YYYY-MM-DD calendar date for display, always in UTC (see dateFmt). */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return dateFmt.format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * Renders all digests grouped by date (newest first), then by topic within
 * each date (issue #101). On Home the caller passes only today's digests so
 * there is at most one date section; the same grouping as History keeps the
 * two views structurally consistent.
 */
export function renderDigestList(digests: readonly Digest[], topics: readonly Topic[]): HTMLElement {
  const container = document.createElement("div");
  container.className = "digest-list";

  const groups = groupDigestsByDateAndTopic(digests, topics);
  if (groups.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No news items were found.";
    container.appendChild(empty);
    return container;
  }

  for (const dateGroup of groups) {
    const section = document.createElement("section");
    section.className = "date-group";
    section.setAttribute("data-date", dateGroup.date);

    const dateHeading = document.createElement("h2");
    dateHeading.className = "date-heading";
    dateHeading.textContent = formatDate(dateGroup.date);
    dateHeading.setAttribute("data-date", dateGroup.date);
    section.appendChild(dateHeading);

    for (const topicBucket of dateGroup.topics) {
      const topicHeading = document.createElement("h3");
      topicHeading.className = "topic-heading";
      topicHeading.setAttribute("data-topic-slug", topicBucket.slug);
      topicHeading.textContent = topicBucket.name;
      section.appendChild(topicHeading);

      for (const digest of topicBucket.digests) {
        section.appendChild(renderDigestCard(digest));
      }
    }

    container.appendChild(section);
  }

  return container;
}
