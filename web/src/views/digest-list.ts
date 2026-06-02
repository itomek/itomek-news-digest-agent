import { groupDigestsByTopicAndDate } from "../lib/group";
import type { Digest, Topic } from "../lib/types";
import { renderDigestCard } from "./digest-card";

const dateFmt = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
});

function formatDate(iso: string): string {
  // iso is YYYY-MM-DD; render in local-neutral form without TZ shifting.
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return dateFmt.format(new Date(Date.UTC(y, m - 1, d)));
}

/** Renders all digests grouped by topic, then by date (newest first). */
export function renderDigestList(digests: readonly Digest[], topics: readonly Topic[]): HTMLElement {
  const container = document.createElement("div");
  container.className = "digest-list";

  const groups = groupDigestsByTopicAndDate(digests, topics);
  if (groups.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No digests yet. Check back after the next run.";
    container.appendChild(empty);
    return container;
  }

  for (const group of groups) {
    const section = document.createElement("section");
    section.className = "topic-group";
    section.setAttribute("data-topic-slug", group.slug);

    const heading = document.createElement("h2");
    heading.className = "topic-heading";
    heading.textContent = group.name;
    section.appendChild(heading);

    for (const dateGroup of group.dates) {
      const dateHeading = document.createElement("h3");
      dateHeading.className = "date-heading";
      dateHeading.textContent = formatDate(dateGroup.date);
      dateHeading.setAttribute("data-date", dateGroup.date);
      section.appendChild(dateHeading);

      for (const digest of dateGroup.digests) {
        section.appendChild(renderDigestCard(digest));
      }
    }

    container.appendChild(section);
  }

  return container;
}
