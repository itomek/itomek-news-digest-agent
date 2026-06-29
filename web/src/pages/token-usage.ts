import type { SupabaseClient } from "@supabase/supabase-js";
import { isAuthenticatedAtRequiredLevel } from "../lib/auth";
import { fetchTokenUsage } from "../lib/supabase";
import type { TokenUsageDay } from "../lib/types";
import { buildAppNav } from "../views/app-nav";
import { renderAuthGate } from "../views/auth-gate";

// Issue #20 — Token usage dashboard at `#/token-usage`.
// Aggregates summarize rows' token counts from v_token_usage_by_day by
// day + topic + model. CSS bars only — no chart library.
// Note: local Lemonade often reports 0 tokens; falls back to duration_s display.

// --- Pure, DOM-free helpers (unit-tested) ------------------------------------

/** Group rows by day, then by topic_slug + model_id combo within each day. */
export interface DayGroup {
  day: string;
  rows: TokenUsageDay[];
  total_tokens: number;
  total_duration_s: number;
}

export function groupByDay(rows: TokenUsageDay[]): DayGroup[] {
  const map = new Map<string, DayGroup>();
  for (const row of rows) {
    const existing = map.get(row.day);
    if (existing) {
      existing.rows.push(row);
      existing.total_tokens += row.total_tokens ?? 0;
      existing.total_duration_s += row.total_duration_s ?? 0;
    } else {
      map.set(row.day, {
        day: row.day,
        rows: [row],
        total_tokens: row.total_tokens ?? 0,
        total_duration_s: row.total_duration_s ?? 0,
      });
    }
  }
  // Return sorted newest-first (input is already DESC from the query)
  return [...map.values()];
}

/** True when all rows in the dataset report zero total_tokens. */
export function allZeroTokens(rows: TokenUsageDay[]): boolean {
  return rows.every((r) => (r.total_tokens ?? 0) === 0);
}

/** Format a token count: "1,234 tokens" or "—" for zero/null. */
export function formatTokens(n: number | null | undefined): string {
  const v = n ?? 0;
  if (v === 0) return "—";
  return `${v.toLocaleString()} tok`;
}

/** Format duration_s: "12.3 s" or "—" for zero/null. */
export function formatDuration(s: number | null | undefined): string {
  const v = s ?? 0;
  if (v === 0) return "—";
  return `${v.toFixed(1)} s`;
}

/** The bar-chart primary metric per row: tokens when available, else duration. */
export function primaryMetric(
  row: TokenUsageDay,
  useTokens: boolean,
): number {
  if (useTokens) return row.total_tokens ?? 0;
  return row.total_duration_s ?? 0;
}

/** Label for the bar chart axis depending on mode. */
export function primaryMetricLabel(useTokens: boolean): string {
  return useTokens ? "Tokens" : "Duration (s)";
}

// --- DOM rendering -----------------------------------------------------------

/** Render a single day group as a card with per-row bars. */
function renderDayCard(group: DayGroup, maxMetric: number, useTokens: boolean): HTMLElement {
  const card = document.createElement("section");
  card.className = "token-day-card";
  card.setAttribute("data-testid", "token-day-card");

  const heading = document.createElement("h2");
  heading.className = "token-day-heading";
  heading.textContent = group.day;

  const totals = document.createElement("p");
  totals.className = "token-day-totals";
  const tokStr = group.total_tokens > 0
    ? `${group.total_tokens.toLocaleString()} tokens`
    : "tokens not reported";
  const durStr = `${group.total_duration_s.toFixed(1)} s total`;
  totals.textContent = `${tokStr} · ${durStr}`;

  card.appendChild(heading);
  card.appendChild(totals);

  for (const row of group.rows) {
    const rowEl = document.createElement("div");
    rowEl.className = "token-row";
    rowEl.setAttribute("data-testid", "token-row");

    const label = document.createElement("div");
    label.className = "token-row-label";
    const topicSpan = document.createElement("span");
    topicSpan.className = "token-row-topic";
    topicSpan.textContent = row.topic_slug ?? "(unknown)";
    const modelSpan = document.createElement("span");
    modelSpan.className = "token-row-model";
    modelSpan.textContent = row.model_id ?? "";
    label.appendChild(topicSpan);
    if (row.model_id) label.appendChild(modelSpan);

    const barOuter = document.createElement("div");
    barOuter.className = "bar-outer";
    const metric = primaryMetric(row, useTokens);
    const pct = maxMetric > 0 ? Math.round((metric / maxMetric) * 100) : 0;
    const barInner = document.createElement("div");
    barInner.className = "bar-inner bar-inner--token";
    barInner.style.width = `${pct}%`;
    barInner.setAttribute("aria-hidden", "true");
    barOuter.appendChild(barInner);

    const valueEl = document.createElement("div");
    valueEl.className = "token-row-value";
    if (useTokens) {
      valueEl.textContent = formatTokens(row.total_tokens);
    } else {
      valueEl.textContent = formatDuration(row.total_duration_s);
    }

    rowEl.append(label, barOuter, valueEl);
    card.appendChild(rowEl);
  }

  return card;
}

export async function renderTokenUsagePage(
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
  title.textContent = "Token Usage";
  header.appendChild(title);
  header.appendChild(buildAppNav(client, "#/token-usage"));
  root.appendChild(header);

  const main = document.createElement("main");
  main.className = "app-main";
  main.setAttribute("data-testid", "token-usage-content");

  const loading = document.createElement("p");
  loading.textContent = "Loading token usage…";
  main.appendChild(loading);
  root.appendChild(main);

  try {
    const rows = await fetchTokenUsage(client, 30);
    main.replaceChildren();

    if (rows.length === 0) {
      const p = document.createElement("p");
      p.className = "empty-state";
      p.textContent = "No LLM run data yet. Token usage is populated after the first agent run.";
      main.appendChild(p);
      return;
    }

    const useTokens = !allZeroTokens(rows);

    // Mode note
    const modeNote = document.createElement("p");
    modeNote.className = "agg-note";
    modeNote.textContent = useTokens
      ? `Showing token counts by day, topic, and model (last 30 days).`
      : `Token counts not reported by this model — showing run duration instead (last 30 days).`;
    main.appendChild(modeNote);

    const groups = groupByDay(rows);

    // Determine max metric across all rows for bar scaling
    const maxMetric = Math.max(
      ...rows.map((r) => primaryMetric(r, useTokens)),
      1,
    );

    const axisLabel = document.createElement("p");
    axisLabel.className = "agg-note";
    axisLabel.textContent = `Bar width = ${primaryMetricLabel(useTokens)} (relative)`;
    main.appendChild(axisLabel);

    for (const group of groups) {
      main.appendChild(renderDayCard(group, maxMetric, useTokens));
    }
  } catch (err) {
    main.replaceChildren();
    const msg = document.createElement("p");
    msg.className = "error-state";
    msg.textContent = `Could not load token usage: ${(err as Error).message}`;
    main.appendChild(msg);
  }
}
