import type { SupabaseClient } from "@supabase/supabase-js";
import { isAuthenticatedAtRequiredLevel } from "../lib/auth";
import { defaultLogsFilter, LOG_PAGE_SIZE, type LogLevel } from "../lib/query";
import {
  fetchErrorsPerDay,
  fetchLogsExtended,
  fetchRunDurations,
  fetchSourceHealth,
  fetchTopics,
} from "../lib/supabase";
import type { ErrorsPerDay, RunDuration, SourceHealth, SystemLog, Topic } from "../lib/types";
import { isSourceStale } from "../lib/staleness";
import { buildAppNav } from "../views/app-nav";
import { renderAuthGate } from "../views/auth-gate";

// Issue #27 — Log view UI at `#/logs`.
// Issue #20 — Extended with search, aggregation tab, and source-health summary.
//
// URL state lives in `window.location.search`. The router keys on the hash,
// so search params survive routing and are shareable/bookmarkable.
// Changing a filter calls history.replaceState and re-fetches from Supabase
// (unlike history.ts which is fully client-side; logs may be large so we
// filter server-side).

// --- Pure, DOM-free helpers (unit-tested) ------------------------------------

/** Canonical log categories emitted by the agent.
 *  Transcribed from the `Category` Literal in src/news_digest/logging.py:10-18. */
export const LOG_CATEGORIES = [
  "schedule",
  "scrape",
  "summarize",
  "publish",
  "feedback",
  "hello_world",
  "system",
] as const;

/** Known topic slugs, used only if the digest_topics fetch fails. The
 *  authenticated role CAN read digest_topics (migration 0006), so the dropdown
 *  is normally populated from the table; this is a network-failure fallback. */
export const FALLBACK_TOPIC_SLUGS = [
  "ai_models",
  "ai_updates",
  "f1",
  "local_news",
  "penguins",
  "world_news",
] as const;

export interface LogsState {
  dateFrom: string;
  dateTo: string;
  level: LogLevel | null;
  category: string;
  topic_slug: string;
  search: string;
  page: number;
}

/** Parse `?dateFrom=&dateTo=&level=&category=&topic_slug=&search=&page=` into LogsState. */
export function parseLogsState(search: string): LogsState {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const defaults = defaultLogsFilter();
  const level = params.get("level");
  return {
    dateFrom: params.get("dateFrom") ?? defaults.dateFrom,
    dateTo: params.get("dateTo") ?? defaults.dateTo,
    level: (level === "info" || level === "warn" || level === "error") ? level : null,
    category: params.get("category") ?? "",
    topic_slug: params.get("topic_slug") ?? "",
    search: params.get("search") ?? "",
    page: Math.max(0, Number.parseInt(params.get("page") ?? "0", 10) || 0),
  };
}

/** Serialize a LogsState to a search string. dateFrom/dateTo are always emitted for
 *  shareability; optional fields are omitted when empty/default. */
export function serializeLogsState(state: LogsState): string {
  const params = new URLSearchParams();
  params.set("dateFrom", state.dateFrom);
  params.set("dateTo", state.dateTo);
  if (state.level) params.set("level", state.level);
  if (state.category.trim()) params.set("category", state.category.trim());
  if (state.topic_slug.trim()) params.set("topic_slug", state.topic_slug.trim());
  if (state.search.trim()) params.set("search", state.search.trim());
  if (state.page > 0) params.set("page", String(state.page));
  return `?${params.toString()}`;
}

/** Level badge CSS class name. */
export function levelClass(level: string): string {
  if (level === "error") return "log-level log-level--error";
  if (level === "warn") return "log-level log-level--warn";
  return "log-level log-level--info";
}

/** Format an ISO timestamp to a short local date-time string. */
export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** Render metadata JSON as a pretty-printed string, or "—" if empty. */
export function prettyMetadata(metadata: unknown): string {
  if (metadata === null || metadata === undefined) return "—";
  try {
    return JSON.stringify(metadata, null, 2);
  } catch {
    return String(metadata);
  }
}

/** Format a success rate percentage, or "N/A" when null. */
export function formatSuccessPct(pct: number | null): string {
  if (pct === null) return "N/A";
  return `${pct.toFixed(1)}%`;
}

/** Format an average duration in seconds, or "—" when null/zero. */
export function formatAvgDuration(s: number | null): string {
  if (s === null || s === 0) return "—";
  return `${s.toFixed(1)} s`;
}

// --- DOM rendering -----------------------------------------------------------

function readState(): LogsState {
  return parseLogsState(window.location.search);
}

function writeState(state: LogsState): void {
  const search = serializeLogsState(state);
  const url = `${window.location.pathname}${search}${window.location.hash}`;
  window.history.replaceState(null, "", url);
}

function renderRow(log: SystemLog): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.setAttribute("data-testid", "log-row");
  tr.setAttribute("data-log-id", log.id);

  // Timestamp
  const tdTs = document.createElement("td");
  tdTs.className = "log-ts";
  tdTs.textContent = formatTimestamp(log.timestamp);
  tr.appendChild(tdTs);

  // Level badge
  const tdLevel = document.createElement("td");
  const badge = document.createElement("span");
  badge.className = levelClass(log.level);
  badge.textContent = log.level;
  tdLevel.appendChild(badge);
  tr.appendChild(tdLevel);

  // Category
  const tdCat = document.createElement("td");
  tdCat.className = "log-category";
  tdCat.textContent = log.category;
  tr.appendChild(tdCat);

  // Topic slug
  const tdTopic = document.createElement("td");
  tdTopic.className = "log-topic";
  tdTopic.textContent = log.topic_slug ?? "—";
  tr.appendChild(tdTopic);

  // Message
  const tdMsg = document.createElement("td");
  tdMsg.className = "log-message";
  tdMsg.textContent = log.message;
  tr.appendChild(tdMsg);

  // Metadata — collapsible via <details>
  const tdMeta = document.createElement("td");
  tdMeta.className = "log-meta";
  const pretty = prettyMetadata(log.metadata);
  if (pretty === "—") {
    tdMeta.textContent = "—";
  } else {
    const details = document.createElement("details");
    details.className = "log-meta-details";
    const summary = document.createElement("summary");
    summary.textContent = "view";
    details.appendChild(summary);
    const pre = document.createElement("pre");
    pre.className = "log-meta-pre";
    pre.textContent = pretty;
    details.appendChild(pre);
    tdMeta.appendChild(details);
  }
  tr.appendChild(tdMeta);

  return tr;
}

function renderTable(rows: SystemLog[]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "logs-table-wrap";

  const table = document.createElement("table");
  table.className = "logs-table";
  table.setAttribute("data-testid", "logs-table");

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Timestamp", "Level", "Category", "Topic", "Message", "Metadata"]) {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  if (rows.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.setAttribute("colspan", "6");
    td.className = "empty-state";
    td.textContent = "No log entries match these filters.";
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    for (const row of rows) {
      tbody.appendChild(renderRow(row));
    }
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

interface FilterBar {
  el: HTMLElement;
  sync: (state: LogsState) => void;
}

function buildSelect(opts: {
  testid: string;
  ariaLabel: string;
  allLabel: string;
  values: readonly string[];
  initial: string;
}): HTMLSelectElement {
  const select = document.createElement("select");
  select.className = "logs-filter-select";
  select.setAttribute("data-testid", opts.testid);
  select.setAttribute("aria-label", opts.ariaLabel);
  const allOpt = document.createElement("option");
  allOpt.value = "";
  allOpt.textContent = opts.allLabel;
  select.appendChild(allOpt);
  for (const value of opts.values) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = value;
    select.appendChild(opt);
  }
  select.value = opts.initial;
  // An unknown initial (hand-edited URL) leaves value "" — treat as All.
  if (select.value !== opts.initial) select.value = "";
  return select;
}

function buildFilterBar(
  initial: LogsState,
  topicSlugs: readonly string[],
  onChange: (next: LogsState) => void,
): FilterBar {
  const bar = document.createElement("div");
  bar.className = "logs-filters";
  bar.setAttribute("data-testid", "logs-filters");

  // Date range — from
  const dateFromLabel = document.createElement("label");
  dateFromLabel.textContent = "From";
  dateFromLabel.setAttribute("for", "logs-date-from");
  dateFromLabel.className = "logs-filter-label";
  const dateFrom = document.createElement("input");
  dateFrom.type = "datetime-local";
  dateFrom.id = "logs-date-from";
  dateFrom.className = "logs-filter-input";
  dateFrom.setAttribute("data-testid", "filter-date-from");
  dateFrom.value = toDatetimeLocal(initial.dateFrom);
  dateFrom.setAttribute("aria-label", "Logs from date");

  // Date range — to
  const dateToLabel = document.createElement("label");
  dateToLabel.textContent = "To";
  dateToLabel.setAttribute("for", "logs-date-to");
  dateToLabel.className = "logs-filter-label";
  const dateTo = document.createElement("input");
  dateTo.type = "datetime-local";
  dateTo.id = "logs-date-to";
  dateTo.className = "logs-filter-input";
  dateTo.setAttribute("data-testid", "filter-date-to");
  dateTo.value = toDatetimeLocal(initial.dateTo);
  dateTo.setAttribute("aria-label", "Logs to date");

  // Level
  const levelSelect = document.createElement("select");
  levelSelect.className = "logs-filter-select";
  levelSelect.setAttribute("data-testid", "filter-level");
  levelSelect.setAttribute("aria-label", "Filter by log level");
  for (const [value, label] of [["", "All levels"], ["info", "Info"], ["warn", "Warn"], ["error", "Error"]] as const) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    levelSelect.appendChild(opt);
  }
  levelSelect.value = initial.level ?? "";

  // Category — select over the agent's canonical categories (exact-match filter,
  // so free text would silently return zero rows on partial/case-different input).
  const categorySelect = buildSelect({
    testid: "filter-category",
    ariaLabel: "Filter by category",
    allLabel: "All categories",
    values: LOG_CATEGORIES,
    initial: initial.category,
  });

  // Topic slug — select populated from digest_topics (or the static fallback).
  const topicSelect = buildSelect({
    testid: "filter-topic-slug",
    ariaLabel: "Filter by topic slug",
    allLabel: "All topics",
    values: topicSlugs,
    initial: initial.topic_slug,
  });

  // Message search
  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.className = "logs-filter-input logs-search-input";
  searchInput.setAttribute("data-testid", "filter-search");
  searchInput.setAttribute("aria-label", "Search log messages");
  searchInput.placeholder = "Search messages…";
  searchInput.value = initial.search;

  const applyButton = document.createElement("button");
  applyButton.type = "button";
  applyButton.className = "logs-filter-apply";
  applyButton.setAttribute("data-testid", "filter-apply");
  applyButton.textContent = "Apply";

  bar.append(
    dateFromLabel, dateFrom,
    dateToLabel, dateTo,
    levelSelect,
    categorySelect,
    topicSelect,
    searchInput,
    applyButton,
  );

  const collect = (): LogsState => ({
    dateFrom: fromDatetimeLocal(dateFrom.value) || readState().dateFrom,
    dateTo: fromDatetimeLocal(dateTo.value) || readState().dateTo,
    level: (levelSelect.value as LogLevel) || null,
    category: categorySelect.value,
    topic_slug: topicSelect.value,
    search: searchInput.value,
    page: 0, // reset to first page on any filter change
  });

  // Apply commits date range + search; selects fire immediately.
  applyButton.addEventListener("click", () => onChange(collect()));
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") onChange(collect());
  });
  for (const select of [levelSelect, categorySelect, topicSelect]) {
    select.addEventListener("change", () => onChange(collect()));
  }

  const sync = (state: LogsState) => {
    dateFrom.value = toDatetimeLocal(state.dateFrom);
    dateTo.value = toDatetimeLocal(state.dateTo);
    levelSelect.value = state.level ?? "";
    categorySelect.value = state.category;
    topicSelect.value = state.topic_slug;
    searchInput.value = state.search;
  };

  return { el: bar, sync };
}

function renderPager(
  state: LogsState,
  rowCount: number,
  hasMore: boolean,
  onChange: (next: LogsState) => void,
): HTMLElement {
  const pager = document.createElement("div");
  pager.className = "logs-pager";
  pager.setAttribute("data-testid", "logs-pager");

  const prev = document.createElement("button");
  prev.type = "button";
  prev.textContent = "← Prev";
  prev.disabled = state.page === 0;
  prev.setAttribute("data-testid", "pager-prev");
  prev.addEventListener("click", () => onChange({ ...state, page: state.page - 1 }));

  const info = document.createElement("span");
  info.className = "logs-pager-info";
  info.textContent = pagerLabel(state.page, rowCount);

  const next = document.createElement("button");
  next.type = "button";
  next.textContent = "Next →";
  next.disabled = !hasMore;
  next.setAttribute("data-testid", "pager-next");
  next.addEventListener("click", () => onChange({ ...state, page: state.page + 1 }));

  pager.append(prev, info, next);
  return pager;
}

// --- Aggregation tab ---------------------------------------------------------

function renderErrorsPerDayBar(rows: ErrorsPerDay[]): HTMLElement {
  const section = document.createElement("section");
  section.className = "agg-section";

  const heading = document.createElement("h2");
  heading.className = "agg-heading";
  heading.textContent = "Errors per day (last 30 days)";
  section.appendChild(heading);

  if (rows.length === 0) {
    const p = document.createElement("p");
    p.className = "empty-state";
    p.textContent = "No errors in this period.";
    section.appendChild(p);
    return section;
  }

  const maxCount = Math.max(...rows.map((r) => r.error_count), 1);
  const chart = document.createElement("div");
  chart.className = "bar-chart";
  chart.setAttribute("aria-label", "Errors per day bar chart");
  chart.setAttribute("role", "img");

  for (const row of rows) {
    const barWrap = document.createElement("div");
    barWrap.className = "bar-row";

    const label = document.createElement("span");
    label.className = "bar-label";
    label.textContent = row.day;

    const barOuter = document.createElement("div");
    barOuter.className = "bar-outer";

    const barInner = document.createElement("div");
    barInner.className = "bar-inner bar-inner--error";
    const pct = Math.round((row.error_count / maxCount) * 100);
    barInner.style.width = `${pct}%`;
    barInner.setAttribute("aria-hidden", "true");

    const value = document.createElement("span");
    value.className = "bar-value";
    value.textContent = String(row.error_count);

    barOuter.appendChild(barInner);
    barWrap.append(label, barOuter, value);
    chart.appendChild(barWrap);
  }

  section.appendChild(chart);
  return section;
}

function renderSourceSuccessTable(rows: SourceHealth[]): HTMLElement {
  const section = document.createElement("section");
  section.className = "agg-section";

  const heading = document.createElement("h2");
  heading.className = "agg-heading";
  heading.textContent = "Success rate per source (last 7 days)";
  section.appendChild(heading);

  if (rows.length === 0) {
    const p = document.createElement("p");
    p.className = "empty-state";
    p.textContent = "No scrape data in this period.";
    section.appendChild(p);
    return section;
  }

  const wrap = document.createElement("div");
  wrap.className = "logs-table-wrap";

  const table = document.createElement("table");
  table.className = "logs-table agg-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Source URL", "Success", "Failure", "Rate", "Last Success"]) {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    const stale = isSourceStale(row);
    if (stale) tr.className = "source-stale";

    const tdUrl = document.createElement("td");
    tdUrl.className = "agg-source-url";
    tdUrl.textContent = row.source_url;
    tr.appendChild(tdUrl);

    const tdSuccess = document.createElement("td");
    tdSuccess.textContent = String(row.success_7d);
    tr.appendChild(tdSuccess);

    const tdFail = document.createElement("td");
    tdFail.textContent = String(row.failure_7d);
    tr.appendChild(tdFail);

    const tdRate = document.createElement("td");
    tdRate.textContent = formatSuccessPct(row.success_pct_7d);
    if (stale) tdRate.className = "source-stale-cell";
    tr.appendChild(tdRate);

    const tdLast = document.createElement("td");
    tdLast.textContent = row.last_success_at ? formatTimestamp(row.last_success_at) : "Never";
    tr.appendChild(tdLast);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  section.appendChild(wrap);
  return section;
}

function renderRunDurationTable(rows: RunDuration[]): HTMLElement {
  const section = document.createElement("section");
  section.className = "agg-section";

  const heading = document.createElement("h2");
  heading.className = "agg-heading";
  heading.textContent = "Average run duration (per topic and model)";
  section.appendChild(heading);

  if (rows.length === 0) {
    const p = document.createElement("p");
    p.className = "empty-state";
    p.textContent = "No LLM run data yet.";
    section.appendChild(p);
    return section;
  }

  const wrap = document.createElement("div");
  wrap.className = "logs-table-wrap";

  const table = document.createElement("table");
  table.className = "logs-table agg-table";
  table.setAttribute("data-testid", "run-duration-table");

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Topic", "Model", "Runs", "Avg Duration", "Last Run"]) {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");

    const tdTopic = document.createElement("td");
    tdTopic.textContent = row.topic_slug ?? "—";
    tr.appendChild(tdTopic);

    const tdModel = document.createElement("td");
    tdModel.className = "agg-source-url";
    tdModel.textContent = row.model_id ?? "—";
    tr.appendChild(tdModel);

    const tdRuns = document.createElement("td");
    tdRuns.textContent = String(row.run_count);
    tr.appendChild(tdRuns);

    const tdDur = document.createElement("td");
    tdDur.textContent = formatAvgDuration(row.avg_duration_s);
    tr.appendChild(tdDur);

    const tdLast = document.createElement("td");
    tdLast.className = "log-ts";
    tdLast.textContent = row.last_run_at ? formatTimestamp(row.last_run_at) : "—";
    tr.appendChild(tdLast);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  section.appendChild(wrap);
  return section;
}

/** Convert ISO string to `datetime-local` input format (`YYYY-MM-DDTHH:MM`).
 *  Returns "" for unparseable input (new Date never throws; it yields NaN). */
export function toDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Convert `datetime-local` value back to an ISO string (local timezone).
 *  Returns "" for empty or unparseable input. */
export function fromDatetimeLocal(value: string): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString();
}

/** Human label for the pager: row range on this page, or "No rows". */
export function pagerLabel(page: number, rowCount: number): string {
  if (rowCount === 0) return "No rows";
  const first = page * LOG_PAGE_SIZE + 1;
  return `Rows ${first}–${first + rowCount - 1}`;
}

export async function renderLogs(root: HTMLElement, client: SupabaseClient): Promise<void> {
  if (!(await isAuthenticatedAtRequiredLevel(client))) {
    renderAuthGate(root, client);
    return;
  }

  root.replaceChildren();

  // Header
  const header = document.createElement("header");
  header.className = "app-header";
  const title = document.createElement("h1");
  title.textContent = "Logs";
  header.appendChild(title);

  header.appendChild(buildAppNav(client, "#/logs"));
  root.appendChild(header);

  const main = document.createElement("main");
  main.className = "app-main";
  main.setAttribute("data-testid", "logs-content");
  const loading = document.createElement("p");
  loading.textContent = "Loading logs…";
  main.appendChild(loading);
  root.appendChild(main);

  // Topic dropdown options come from digest_topics (the authenticated role can
  // read it — migration 0006). On failure fall back to the static slug list so
  // a transient error doesn't take the whole filter bar down.
  let topicSlugs: readonly string[];
  try {
    const topics: Topic[] = await fetchTopics(client);
    topicSlugs = topics.map((t) => t.slug);
  } catch {
    topicSlugs = FALLBACK_TOPIC_SLUGS;
  }

  main.replaceChildren();

  // Tab switcher: Log Explorer | Aggregations
  const tabBar = document.createElement("div");
  tabBar.className = "logs-tab-bar";
  tabBar.setAttribute("role", "tablist");

  const tabExplorer = document.createElement("button");
  tabExplorer.type = "button";
  tabExplorer.className = "logs-tab logs-tab--active";
  tabExplorer.setAttribute("role", "tab");
  tabExplorer.setAttribute("aria-selected", "true");
  tabExplorer.setAttribute("data-testid", "tab-explorer");
  tabExplorer.textContent = "Log Explorer";

  const tabAgg = document.createElement("button");
  tabAgg.type = "button";
  tabAgg.className = "logs-tab";
  tabAgg.setAttribute("role", "tab");
  tabAgg.setAttribute("aria-selected", "false");
  tabAgg.setAttribute("data-testid", "tab-aggregations");
  tabAgg.textContent = "Aggregations";

  tabBar.append(tabExplorer, tabAgg);
  main.appendChild(tabBar);

  // Panels
  const explorerPanel = document.createElement("div");
  explorerPanel.setAttribute("data-testid", "panel-explorer");

  const aggPanel = document.createElement("div");
  aggPanel.setAttribute("data-testid", "panel-aggregations");
  aggPanel.style.display = "none";

  main.append(explorerPanel, aggPanel);

  // Wire tab switching
  tabExplorer.addEventListener("click", () => {
    tabExplorer.classList.add("logs-tab--active");
    tabExplorer.setAttribute("aria-selected", "true");
    tabAgg.classList.remove("logs-tab--active");
    tabAgg.setAttribute("aria-selected", "false");
    explorerPanel.style.display = "";
    aggPanel.style.display = "none";
  });

  tabAgg.addEventListener("click", () => {
    tabAgg.classList.add("logs-tab--active");
    tabAgg.setAttribute("aria-selected", "true");
    tabExplorer.classList.remove("logs-tab--active");
    tabExplorer.setAttribute("aria-selected", "false");
    aggPanel.style.display = "";
    explorerPanel.style.display = "none";
    void loadAgg();
  });

  // ── Explorer tab ──────────────────────────────────────────────────────────

  // Build filter bar once; onChange triggers a re-fetch.
  let currentState = readState();
  const onStateChange = (next: LogsState) => {
    currentState = next;
    writeState(next);
    bar.sync(next);
    void load(next);
  };
  const bar = buildFilterBar(currentState, topicSlugs, onStateChange);
  explorerPanel.appendChild(bar.el);

  const contentArea = document.createElement("div");
  contentArea.setAttribute("data-testid", "logs-results");
  explorerPanel.appendChild(contentArea);

  async function load(state: LogsState): Promise<void> {
    contentArea.replaceChildren();
    const loadingMsg = document.createElement("p");
    loadingMsg.textContent = "Loading logs…";
    contentArea.appendChild(loadingMsg);

    try {
      const { rows, hasMore } = await fetchLogsExtended(client, {
        dateFrom: state.dateFrom,
        dateTo: state.dateTo,
        level: state.level,
        category: state.category,
        topic_slug: state.topic_slug,
        search: state.search,
        page: state.page,
      });

      contentArea.replaceChildren();

      // Pager is suppressed on an empty first page; on a later page it stays so
      // "Prev" can recover from paging past the end (e.g. a stale ?page= URL).
      const showPager = rows.length > 0 || state.page > 0;
      if (showPager) {
        contentArea.appendChild(renderPager(state, rows.length, hasMore, onStateChange));
      }
      contentArea.appendChild(renderTable(rows));
      if (rows.length > 0) {
        const pagerBot = renderPager(state, rows.length, hasMore, (next) => {
          onStateChange(next);
          window.scrollTo({ top: 0 });
        });
        contentArea.appendChild(pagerBot);
      }
    } catch (err) {
      contentArea.replaceChildren();
      const msg = document.createElement("p");
      msg.className = "error-state";
      msg.textContent = `Could not load logs: ${(err as Error).message}`;
      contentArea.appendChild(msg);
    }
  }

  void load(currentState);

  // ── Aggregations tab ─────────────────────────────────────────────────────

  let aggLoaded = false;

  async function loadAgg(): Promise<void> {
    if (aggLoaded) return;
    aggLoaded = true;

    aggPanel.replaceChildren();
    const loadingMsg = document.createElement("p");
    loadingMsg.textContent = "Loading aggregates…";
    aggPanel.appendChild(loadingMsg);

    try {
      const [errRows, healthRows, durationRows] = await Promise.all([
        fetchErrorsPerDay(client, 30),
        fetchSourceHealth(client),
        fetchRunDurations(client),
      ]);

      aggPanel.replaceChildren();
      aggPanel.appendChild(renderErrorsPerDayBar(errRows));
      aggPanel.appendChild(renderSourceSuccessTable(healthRows));
      aggPanel.appendChild(renderRunDurationTable(durationRows));
    } catch (err) {
      // Reset so the user can retry by clicking the tab again.
      aggLoaded = false;
      aggPanel.replaceChildren();
      const msg = document.createElement("p");
      msg.className = "error-state";
      msg.textContent = `Could not load aggregates: ${(err as Error).message}`;
      aggPanel.appendChild(msg);
    }
  }
}
