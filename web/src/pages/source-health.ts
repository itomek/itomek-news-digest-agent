import type { SupabaseClient } from "@supabase/supabase-js";
import { isAuthenticatedAtRequiredLevel, signOut } from "../lib/auth";
import { fetchSourceHealth } from "../lib/supabase";
import type { SourceHealth } from "../lib/types";
import { renderAuthGate } from "../views/auth-gate";

// Issue #20 — Source health page at `#/source-health`.
// Reads from mv_source_health (materialized view, refreshed hourly via pg_cron).
// Stale = <50% success over 7 days OR >72h since last successful fetch → red.

// --- Pure, DOM-free helpers (unit-tested) ------------------------------------

/** Staleness thresholds (mirrors the migration's design intent). */
export const STALE_SUCCESS_PCT_THRESHOLD = 50;   // percent — below this = stale
export const STALE_LAST_SUCCESS_HOURS = 72;       // hours since last success = stale

/** Return true when a source is considered stale per the staleness rules. */
export function isSourceStale(row: SourceHealth): boolean {
  const lowRate =
    row.success_pct_7d !== null && row.success_pct_7d < STALE_SUCCESS_PCT_THRESHOLD;
  const noRecentSuccess =
    row.last_success_at === null ||
    Date.now() - new Date(row.last_success_at).getTime() >
      STALE_LAST_SUCCESS_HOURS * 3_600_000;
  return lowRate || noRecentSuccess;
}

/** Format a nullable success-rate percentage. */
export function formatPct(pct: number | null): string {
  if (pct === null) return "N/A";
  return `${pct.toFixed(1)}%`;
}

/** Format a nullable ISO timestamp as a relative "Xh ago" string or absolute. */
export function formatRelativeTime(iso: string | null): string {
  if (!iso) return "Never";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return iso;
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.round(ms / 60_000)}m ago`;
  if (h < 48) return `${Math.round(h)}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

/** Partition rows into stale and healthy. */
export function partitionByHealth(rows: SourceHealth[]): {
  stale: SourceHealth[];
  healthy: SourceHealth[];
} {
  const stale: SourceHealth[] = [];
  const healthy: SourceHealth[] = [];
  for (const row of rows) {
    if (isSourceStale(row)) {
      stale.push(row);
    } else {
      healthy.push(row);
    }
  }
  return { stale, healthy };
}

// --- DOM rendering -----------------------------------------------------------

function renderSourceTable(
  rows: SourceHealth[],
  stale: boolean,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "logs-table-wrap";

  const table = document.createElement("table");
  table.className = "logs-table agg-table";
  table.setAttribute("data-testid", stale ? "source-health-stale-table" : "source-health-healthy-table");

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Source URL", "7d Rate", "Fetches", "Last Success", "Last Error"]) {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    if (stale) tr.className = "source-stale";
    tr.setAttribute("data-testid", "source-health-row");

    const tdUrl = document.createElement("td");
    tdUrl.className = "agg-source-url";
    tdUrl.textContent = row.source_url;
    tr.appendChild(tdUrl);

    const tdRate = document.createElement("td");
    tdRate.className = stale ? "source-stale-cell" : "";
    tdRate.textContent = formatPct(row.success_pct_7d);
    tr.appendChild(tdRate);

    const tdCount = document.createElement("td");
    tdCount.textContent = `${row.success_7d}✓ / ${row.failure_7d}✗`;
    tr.appendChild(tdCount);

    const tdLastOk = document.createElement("td");
    tdLastOk.textContent = formatRelativeTime(row.last_success_at);
    tr.appendChild(tdLastOk);

    const tdLastErr = document.createElement("td");
    tdLastErr.className = "agg-source-url";
    tdLastErr.textContent = row.last_error ?? "—";
    tr.appendChild(tdLastErr);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function buildNav(client: SupabaseClient): HTMLElement {
  const nav = document.createElement("nav");
  nav.className = "app-nav";

  const links: Array<[string, string]> = [
    ["#/", "Today"],
    ["#/history", "History"],
    ["#/logs", "Logs"],
    ["#/token-usage", "Token Usage"],
  ];
  for (const [href, text] of links) {
    const a = document.createElement("a");
    a.href = href;
    a.textContent = text;
    nav.appendChild(a);
  }

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
  return nav;
}

export async function renderSourceHealthPage(
  root: HTMLElement,
  client: SupabaseClient,
): Promise<void> {
  if (!(await isAuthenticatedAtRequiredLevel(client))) {
    renderAuthGate(root, client);
    return;
  }

  root.replaceChildren();

  const header = document.createElement("header");
  header.className = "app-header";
  const title = document.createElement("h1");
  title.textContent = "Source Health";
  header.appendChild(title);
  header.appendChild(buildNav(client));
  root.appendChild(header);

  const main = document.createElement("main");
  main.className = "app-main";
  main.setAttribute("data-testid", "source-health-content");

  const loading = document.createElement("p");
  loading.textContent = "Loading source health…";
  main.appendChild(loading);
  root.appendChild(main);

  try {
    const rows = await fetchSourceHealth(client);
    main.replaceChildren();

    if (rows.length === 0) {
      const p = document.createElement("p");
      p.className = "empty-state";
      p.textContent = "No scrape data yet. Source health is populated after the first agent run.";
      main.appendChild(p);
      return;
    }

    const { stale, healthy } = partitionByHealth(rows);

    // Stale sources section
    const staleSection = document.createElement("section");
    staleSection.className = "agg-section";
    const staleHeading = document.createElement("h2");
    staleHeading.className = "agg-heading agg-heading--stale";
    staleHeading.textContent = stale.length === 0
      ? "Stale sources — none"
      : `Stale sources (${stale.length})`;
    staleSection.appendChild(staleHeading);

    const staleNote = document.createElement("p");
    staleNote.className = "agg-note";
    staleNote.textContent =
      "Stale = <50% success rate in the last 7 days, OR >72 hours since last successful fetch.";
    staleSection.appendChild(staleNote);

    if (stale.length > 0) {
      staleSection.appendChild(renderSourceTable(stale, true));
    }
    main.appendChild(staleSection);

    // Healthy sources section
    if (healthy.length > 0) {
      const healthySection = document.createElement("section");
      healthySection.className = "agg-section";
      const healthyHeading = document.createElement("h2");
      healthyHeading.className = "agg-heading";
      healthyHeading.textContent = `Healthy sources (${healthy.length})`;
      healthySection.appendChild(healthyHeading);
      healthySection.appendChild(renderSourceTable(healthy, false));
      main.appendChild(healthySection);
    }

    // Last refresh note
    const note = document.createElement("p");
    note.className = "agg-note";
    note.textContent = "Data from mv_source_health — refreshed hourly via pg_cron.";
    main.appendChild(note);
  } catch (err) {
    main.replaceChildren();
    const msg = document.createElement("p");
    msg.className = "error-state";
    msg.textContent = `Could not load source health: ${(err as Error).message}`;
    main.appendChild(msg);
  }
}
