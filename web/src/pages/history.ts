import type { SupabaseClient } from "@supabase/supabase-js";
import { isAuthenticatedAtRequiredLevel, signOut } from "../lib/auth";
import { groupDigestsByTopicAndDate } from "../lib/group";
import { fetchAllDigests, fetchTopics } from "../lib/supabase";
import type { Digest, Topic } from "../lib/types";
import { renderAuthGate } from "../views/auth-gate";
import { renderDigestCard } from "../views/digest-card";

// Issue #12 — Digest history view and navigation.
//
// Owns the `#/history` route (registered in main.ts/router.ts — not edited here).
// URL state lives in `window.location.search` (`?topic=&date=&q=`), NOT the hash:
// the router keys only on the hash (`#/history`), so search params survive routing
// and are shareable/bookmarkable. Changing a filter rewrites the search via
// history.replaceState and re-renders the list in place — the hash never changes,
// so no re-route is triggered.
//
// Filtering, searching and grouping are all client-side: the dataset is tiny
// (~5 topics x 30 days = 150 rows), so server-side FTS is unnecessary.

const DEFAULT_WINDOW_DAYS = 7;

// --- Pure, DOM-free helpers (unit-tested) ----------------------------------

export interface HistoryState {
  topic: string | null;
  date: string | null;
  q: string;
}

/** Parse `?topic=&date=&q=` into a HistoryState. */
export function parseHistoryState(search: string): HistoryState {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return {
    topic: params.get("topic") || null,
    date: params.get("date") || null,
    q: params.get("q") ?? "",
  };
}

/** Serialize a HistoryState to a search string (empty fields omitted). */
export function serializeHistoryState(state: HistoryState): string {
  const params = new URLSearchParams();
  if (state.topic) params.set("topic", state.topic);
  if (state.date) params.set("date", state.date);
  if (state.q.trim()) params.set("q", state.q.trim());
  const s = params.toString();
  return s ? `?${s}` : "";
}

/** Count whitespace-delimited words. */
export function wordCount(content: string): number {
  const trimmed = content.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function sourcesOf(digest: Digest): string[] {
  return Array.isArray(digest.sources_used) ? (digest.sources_used as string[]) : [];
}

export interface DigestMeta {
  date: string;
  topicName: string;
  sources: string[];
  words: number;
}

/** Derive per-digest display metadata: date, topic, sources, word count. */
export function digestMeta(digest: Digest, topics: readonly Topic[]): DigestMeta {
  const topic = topics.find((t) => t.slug === digest.topic_slug);
  return {
    date: digest.digest_date,
    topicName: topic?.name ?? digest.topic_slug,
    sources: sourcesOf(digest),
    words: wordCount(digest.content),
  };
}

/**
 * Case-insensitive substring search across digest content. Ranks higher match
 * counts first, breaking ties by digest_date descending. An empty/whitespace query
 * passes everything through unchanged (preserving caller order).
 */
export function searchDigests(digests: readonly Digest[], q: string): Digest[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [...digests];

  const scored: { digest: Digest; score: number }[] = [];
  for (const digest of digests) {
    const hay = digest.content.toLowerCase();
    let score = 0;
    let from = hay.indexOf(needle);
    while (from !== -1) {
      score += 1;
      from = hay.indexOf(needle, from + needle.length);
    }
    if (score > 0) scored.push({ digest, score });
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.digest.digest_date < b.digest.digest_date ? 1 : a.digest.digest_date > b.digest.digest_date ? -1 : 0;
  });

  return scored.map((s) => s.digest);
}

/** Apply topic + date + search filters (search applied last). */
export function filterDigests(digests: readonly Digest[], state: HistoryState): Digest[] {
  let out = [...digests];
  if (state.topic) out = out.filter((d) => d.topic_slug === state.topic);
  if (state.date) out = out.filter((d) => d.digest_date === state.date);
  out = searchDigests(out, state.q);
  return out;
}

/** Keep digests within N days of the newest digest's date (inclusive). */
export function withinLastDays(digests: readonly Digest[], days: number): Digest[] {
  if (digests.length === 0) return [];
  let newest = digests[0].digest_date;
  for (const d of digests) if (d.digest_date > newest) newest = d.digest_date;
  const anchor = Date.parse(`${newest}T00:00:00Z`);
  const cutoff = anchor - (days - 1) * 86_400_000;
  return digests.filter((d) => Date.parse(`${d.digest_date}T00:00:00Z`) >= cutoff);
}

const FIXTURE_TOPICS: Topic[] = [
  { id: 1, name: "AI model releases", slug: "ai_models", cadence: "24h", enabled: true },
  { id: 2, name: "Local news", slug: "local_news", cadence: "7d", enabled: true },
  { id: 3, name: "AI company updates", slug: "ai_updates", cadence: "24h", enabled: true },
  { id: 4, name: "Pittsburgh Penguins", slug: "penguins", cadence: "7d", enabled: true },
  { id: 5, name: "World news", slug: "world_news", cadence: "24h", enabled: true },
];

const FIXTURE_WORDS = [
  "model",
  "release",
  "township",
  "penguins",
  "poland",
  "update",
  "launch",
  "weights",
  "vote",
  "trade",
];

/**
 * Deterministic in-app fixture for the history view, gated to test mode
 * (`?fixture=150` with a valid session). Generates `count` rows spread across the
 * 5 topics x 30 trailing days (so count=150 => exactly 5x30). No randomness, so
 * e2e assertions on filtering/search/perf are stable. This NEVER runs by default;
 * the real network path is the default.
 */
export function generateFixtureDigests(count: number): Digest[] {
  const out: Digest[] = [];
  const topics = FIXTURE_TOPICS;
  const days = 30;
  const base = Date.UTC(2026, 5, 1); // 2026-06-01
  for (let i = 0; i < count; i++) {
    const topic = topics[i % topics.length];
    const dayIndex = Math.floor(i / topics.length) % days;
    const dateMs = base - dayIndex * 86_400_000;
    const digestDate = new Date(dateMs).toISOString().slice(0, 10);
    const w1 = FIXTURE_WORDS[i % FIXTURE_WORDS.length];
    const w2 = FIXTURE_WORDS[(i + 3) % FIXTURE_WORDS.length];
    const content = `${topic.name} digest for ${digestDate}. Today the ${w1} story leads, with a ${w2} angle and three short items to follow. Stay tuned.`;
    out.push({
      id: `fixture-${topic.slug}-${digestDate}-${i}`,
      topic_slug: topic.slug,
      content,
      cadence: topic.cadence,
      digest_date: digestDate,
      sources_used: [`https://example.com/${topic.slug}/${dayIndex}`, "Wire"],
      token_count: 80 + (i % 50),
      prompt_version: "fixture",
      created_at: `${digestDate}T00:00:00Z`,
      summary: null,
      items: null,
    });
  }
  return out;
}

/** Topics list backing the fixture dataset (for grouping/metadata in test mode). */
export function fixtureTopics(): Topic[] {
  return FIXTURE_TOPICS.map((t) => ({ ...t }));
}

// --- DOM rendering ----------------------------------------------------------

function readState(): HistoryState {
  return parseHistoryState(window.location.search);
}

function writeState(state: HistoryState): void {
  const search = serializeHistoryState(state);
  const url = `${window.location.pathname}${search}${window.location.hash}`;
  window.history.replaceState(null, "", url);
}

function fixtureCount(): number | null {
  const n = new URLSearchParams(window.location.search).get("fixture");
  if (!n) return null;
  const parsed = Number.parseInt(n, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function metaLine(meta: DigestMeta): HTMLElement {
  const el = document.createElement("p");
  el.className = "digest-meta";
  el.setAttribute("data-testid", "digest-meta");
  const sources = meta.sources.length ? meta.sources.join(", ") : "—";
  const plural = meta.words === 1 ? "word" : "words";
  el.textContent = `${meta.topicName} · ${meta.date} · ${meta.words} ${plural} · sources: ${sources}`;
  return el;
}

function renderList(
  container: HTMLElement,
  digests: readonly Digest[],
  topics: readonly Topic[],
): void {
  container.replaceChildren();
  const groups = groupDigestsByTopicAndDate(digests, topics);

  if (groups.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No digests match these filters.";
    container.appendChild(empty);
    return;
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
      dateHeading.setAttribute("data-date", dateGroup.date);
      dateHeading.textContent = dateGroup.date;
      section.appendChild(dateHeading);

      for (const digest of dateGroup.digests) {
        const card = renderDigestCard(digest);
        card.appendChild(metaLine(digestMeta(digest, topics)));
        section.appendChild(card);
      }
    }
    container.appendChild(section);
  }
}

interface FilterBar {
  /** The bar element to mount. */
  el: HTMLElement;
  /** Update control values to reflect the given state WITHOUT recreating the
   *  elements, so the search input keeps focus while the user types. */
  sync: (state: HistoryState) => void;
}

function buildFilterBar(
  topics: readonly Topic[],
  initial: HistoryState,
  onChange: (next: HistoryState) => void,
): FilterBar {
  const bar = document.createElement("div");
  bar.className = "history-filters";
  bar.setAttribute("data-testid", "history-filters");

  // Topic filter.
  const topicSelect = document.createElement("select");
  topicSelect.className = "filter-topic";
  topicSelect.setAttribute("data-testid", "filter-topic");
  topicSelect.setAttribute("aria-label", "Filter by topic");
  const allOpt = document.createElement("option");
  allOpt.value = "";
  allOpt.textContent = "All topics";
  topicSelect.appendChild(allOpt);
  for (const t of topics) {
    const opt = document.createElement("option");
    opt.value = t.slug;
    opt.textContent = t.name;
    topicSelect.appendChild(opt);
  }
  topicSelect.value = initial.topic ?? "";
  topicSelect.addEventListener("change", () => {
    onChange({ ...readState(), topic: topicSelect.value || null });
  });
  bar.appendChild(topicSelect);

  // Search box.
  const search = document.createElement("input");
  search.type = "search";
  search.className = "filter-search";
  search.setAttribute("data-testid", "filter-search");
  search.setAttribute("aria-label", "Search digests");
  search.placeholder = "Search digests…";
  search.value = initial.q;
  search.addEventListener("input", () => {
    onChange({ ...readState(), q: search.value });
  });
  bar.appendChild(search);

  const sync = (state: HistoryState) => {
    if (topicSelect.value !== (state.topic ?? "")) topicSelect.value = state.topic ?? "";
    if (search.value !== state.q) search.value = state.q;
  };

  return { el: bar, sync };
}

export async function renderHistory(root: HTMLElement, client: SupabaseClient): Promise<void> {
  if (!(await isAuthenticatedAtRequiredLevel(client))) {
    renderAuthGate(root, client);
    return;
  }

  root.replaceChildren();

  const header = document.createElement("header");
  header.className = "app-header";
  const title = document.createElement("h1");
  title.textContent = "History";
  header.appendChild(title);

  const nav = document.createElement("nav");
  nav.className = "app-nav";
  const homeLink = document.createElement("a");
  homeLink.href = "#/";
  homeLink.textContent = "Today";
  nav.appendChild(homeLink);
  const out = document.createElement("button");
  out.type = "button";
  out.className = "sign-out";
  out.textContent = "Sign out";
  out.addEventListener("click", () => {
    void (async () => {
      await signOut(client);
      window.location.hash = "#/";
      window.location.reload();
    })();
  });
  nav.appendChild(out);
  header.appendChild(nav);
  root.appendChild(header);

  const main = document.createElement("main");
  main.className = "app-main";
  main.setAttribute("data-testid", "history-content");
  const loading = document.createElement("p");
  loading.textContent = "Loading history…";
  main.appendChild(loading);
  root.appendChild(main);

  // Load data: deterministic fixture in test mode, else the live network path.
  let allDigests: Digest[];
  let topics: Topic[];
  const fx = fixtureCount();
  try {
    if (fx) {
      allDigests = generateFixtureDigests(fx);
      topics = fixtureTopics();
    } else {
      [allDigests, topics] = await Promise.all([fetchAllDigests(client), fetchTopics(client)]);
    }
  } catch (err) {
    main.replaceChildren();
    const msg = document.createElement("p");
    msg.className = "error-state";
    msg.textContent = `Could not load history: ${(err as Error).message}`;
    main.appendChild(msg);
    return;
  }

  main.replaceChildren();

  const listContainer = document.createElement("div");
  listContainer.className = "digest-list";
  listContainer.setAttribute("data-testid", "history-list");

  const apply = (state: HistoryState) => {
    // Default view: when no explicit filters, scope to the last 7 days.
    const hasFilter = !!(state.topic || state.date || state.q.trim());
    const scoped = hasFilter ? allDigests : withinLastDays(allDigests, DEFAULT_WINDOW_DAYS);
    renderList(listContainer, filterDigests(scoped, state), topics);
  };

  const onChange = (next: HistoryState) => {
    writeState(next);
    bar.sync(next);
    apply(next);
  };

  // The filter bar is built once; onChange syncs its control values in place so the
  // search input keeps focus as the user types.
  const bar = buildFilterBar(topics, readState(), onChange);
  main.appendChild(bar.el);
  main.appendChild(listContainer);

  apply(readState());
}
