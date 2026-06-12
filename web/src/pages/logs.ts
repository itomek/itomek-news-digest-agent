import type { SupabaseClient } from "@supabase/supabase-js";
import { isAuthenticatedAtRequiredLevel, signOut } from "../lib/auth";
import { defaultLogsFilter, LOG_PAGE_SIZE, type LogLevel } from "../lib/query";
import { fetchLogs } from "../lib/supabase";
import type { SystemLog } from "../lib/types";
import { renderAuthGate } from "../views/auth-gate";

// Issue #27 — Log view UI at `#/logs`.
//
// URL state lives in `window.location.search`. The router keys on the hash,
// so search params survive routing and are shareable/bookmarkable.
// Changing a filter calls history.replaceState and re-fetches from Supabase
// (unlike history.ts which is fully client-side; logs may be large so we
// filter server-side).

// --- Pure, DOM-free helpers (unit-tested) ------------------------------------

export interface LogsState {
  dateFrom: string;
  dateTo: string;
  level: LogLevel | null;
  category: string;
  topic_slug: string;
  page: number;
}

/** Parse `?dateFrom=&dateTo=&level=&category=&topic_slug=&page=` into LogsState. */
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

function buildFilterBar(initial: LogsState, onChange: (next: LogsState) => void): FilterBar {
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

  // Category
  const categoryInput = document.createElement("input");
  categoryInput.type = "text";
  categoryInput.className = "logs-filter-input";
  categoryInput.setAttribute("data-testid", "filter-category");
  categoryInput.setAttribute("aria-label", "Filter by category");
  categoryInput.placeholder = "Category…";
  categoryInput.value = initial.category;

  // Topic slug
  const topicInput = document.createElement("input");
  topicInput.type = "text";
  topicInput.className = "logs-filter-input";
  topicInput.setAttribute("data-testid", "filter-topic-slug");
  topicInput.setAttribute("aria-label", "Filter by topic slug");
  topicInput.placeholder = "Topic slug…";
  topicInput.value = initial.topic_slug;

  const applyButton = document.createElement("button");
  applyButton.type = "button";
  applyButton.className = "logs-filter-apply";
  applyButton.setAttribute("data-testid", "filter-apply");
  applyButton.textContent = "Apply";

  bar.append(
    dateFromLabel, dateFrom,
    dateToLabel, dateTo,
    levelSelect,
    categoryInput,
    topicInput,
    applyButton,
  );

  const collect = (): LogsState => ({
    dateFrom: fromDatetimeLocal(dateFrom.value) || readState().dateFrom,
    dateTo: fromDatetimeLocal(dateTo.value) || readState().dateTo,
    level: (levelSelect.value as LogLevel) || null,
    category: categoryInput.value,
    topic_slug: topicInput.value,
    page: 0, // reset to first page on any filter change
  });

  applyButton.addEventListener("click", () => onChange(collect()));
  // Also fire on Enter in text inputs.
  for (const input of [categoryInput, topicInput]) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") onChange(collect());
    });
  }
  // Level select fires immediately.
  levelSelect.addEventListener("change", () => onChange(collect()));

  const sync = (state: LogsState) => {
    dateFrom.value = toDatetimeLocal(state.dateFrom);
    dateTo.value = toDatetimeLocal(state.dateTo);
    levelSelect.value = state.level ?? "";
    categoryInput.value = state.category;
    topicInput.value = state.topic_slug;
  };

  return { el: bar, sync };
}

function renderPager(
  state: LogsState,
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
  const first = state.page * LOG_PAGE_SIZE + 1;
  const lastApprox = state.page * LOG_PAGE_SIZE + LOG_PAGE_SIZE;
  info.textContent = hasMore
    ? `Rows ${first}–${lastApprox}`
    : `Rows ${first}+`;

  const next = document.createElement("button");
  next.type = "button";
  next.textContent = "Next →";
  next.disabled = !hasMore;
  next.setAttribute("data-testid", "pager-next");
  next.addEventListener("click", () => onChange({ ...state, page: state.page + 1 }));

  pager.append(prev, info, next);
  return pager;
}

/** Convert ISO string to `datetime-local` input format (`YYYY-MM-DDTHH:MM`). */
function toDatetimeLocal(iso: string): string {
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return "";
  }
}

/** Convert `datetime-local` value back to an ISO string (local timezone). */
function fromDatetimeLocal(value: string): string {
  if (!value) return "";
  try {
    return new Date(value).toISOString();
  } catch {
    return "";
  }
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

  const nav = document.createElement("nav");
  nav.className = "app-nav";
  const homeLink = document.createElement("a");
  homeLink.href = "#/";
  homeLink.textContent = "Today";
  nav.appendChild(homeLink);
  const historyLink = document.createElement("a");
  historyLink.href = "#/history";
  historyLink.textContent = "History";
  nav.appendChild(historyLink);
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
  main.setAttribute("data-testid", "logs-content");
  root.appendChild(main);

  // Build filter bar once; onChange triggers a re-fetch.
  let currentState = readState();
  const bar = buildFilterBar(currentState, (next) => {
    currentState = next;
    writeState(next);
    bar.sync(next);
    void load(next);
  });
  main.appendChild(bar.el);

  const contentArea = document.createElement("div");
  contentArea.setAttribute("data-testid", "logs-results");
  main.appendChild(contentArea);

  async function load(state: LogsState): Promise<void> {
    contentArea.replaceChildren();
    const loading = document.createElement("p");
    loading.textContent = "Loading logs…";
    contentArea.appendChild(loading);

    try {
      const { rows, hasMore } = await fetchLogs(client, {
        dateFrom: state.dateFrom,
        dateTo: state.dateTo,
        level: state.level,
        category: state.category,
        topic_slug: state.topic_slug,
        page: state.page,
      });

      contentArea.replaceChildren();

      const pagerTop = renderPager(state, hasMore, (next) => {
        currentState = next;
        writeState(next);
        bar.sync(next);
        void load(next);
      });
      contentArea.appendChild(pagerTop);
      contentArea.appendChild(renderTable(rows));

      // Bottom pager only if there's content.
      if (rows.length > 0) {
        const pagerBot = renderPager(state, hasMore, (next) => {
          currentState = next;
          writeState(next);
          bar.sync(next);
          void load(next);
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
}
