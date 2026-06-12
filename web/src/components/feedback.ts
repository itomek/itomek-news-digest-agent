// Per-digest feedback controls (#22).
//
// Mounts into each card's `.feedback-slot` and into each `.digest-item` via
// the hooks registered in views/digest-card.ts. Auto-registers on import so
// main.ts only needs a single import line.
//
// This module is self-contained: it injects its own scoped styles and
// wires up all UI. The Supabase client is obtained via getSupabase() so the
// same authenticated client used for reads is also used for feedback inserts
// (authenticated RLS policy in migration 0012 permits category='feedback' inserts).

import { registerFeedbackSlotMounter, registerItemFlagMounter } from "../views/digest-card";
import {
  mountFeedbackControls,
  mountItemFlagButtons,
} from "../views/feedback-controls";
import type { Digest } from "../lib/types";
import { getSupabase } from "../lib/supabase";

function injectStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById("feedback-styles")) return;
  const style = document.createElement("style");
  style.id = "feedback-styles";
  style.textContent = `
    /* ── Feedback slot ─────────────────────────────────────────────────── */
    .feedback-slot:empty { display: none; }

    /* ── Feedback panel ────────────────────────────────────────────────── */
    .feedback-panel {
      border-top: 1px solid var(--border, #c8d3df);
      margin-top: 0.75rem;
      padding-top: 0.6rem;
    }

    /* ── Signal row: thumbs-down + positive ────────────────────────────── */
    .feedback-signal-row {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
      align-items: center;
    }

    .feedback-btn {
      font: inherit;
      min-height: 44px;
      padding: 0.35rem 0.85rem;
      border: 1.5px solid var(--border, #c8d3df);
      border-radius: 999px;
      background: transparent;
      color: var(--muted, #4a5568);
      cursor: pointer;
      font-size: 0.82rem;
      font-weight: 600;
      letter-spacing: 0.01em;
      transition: background 160ms, border-color 160ms, color 160ms;
      line-height: 1;
    }

    .feedback-btn:hover:not(:disabled) {
      border-color: var(--accent, #1a56db);
      color: var(--accent, #1a56db);
    }

    .feedback-btn:focus-visible {
      outline: 2px solid transparent;
      box-shadow: 0 0 0 3px rgba(26,86,219,.22);
      border-radius: 999px;
    }

    .feedback-btn:disabled {
      opacity: 0.45;
      cursor: default;
    }

    .feedback-btn--positive:not(:disabled) {
      color: #186a3b;
      border-color: #186a3b;
    }

    .feedback-btn--positive:hover:not(:disabled) {
      background: rgba(24,106,59,.08);
    }

    .feedback-btn--thumbs-down:not(:disabled) {
      color: #b03a2e;
      border-color: #b03a2e;
    }

    .feedback-btn--thumbs-down:hover:not(:disabled) {
      background: rgba(176,58,46,.08);
    }

    @media (prefers-color-scheme: dark) {
      .feedback-btn--positive:not(:disabled) {
        color: #5dd39e;
        border-color: #2e6b4f;
      }
      .feedback-btn--positive:hover:not(:disabled) {
        background: rgba(93,211,158,.10);
      }
      .feedback-btn--thumbs-down:not(:disabled) {
        color: #f1948a;
        border-color: #7b3a32;
      }
      .feedback-btn--thumbs-down:hover:not(:disabled) {
        background: rgba(241,148,138,.10);
      }
    }

    /* ── Status line ───────────────────────────────────────────────────── */
    .feedback-status {
      font-size: 0.8rem;
      color: var(--muted, #4a5568);
      min-height: 1rem;
      margin: 0.2rem 0 0;
    }

    .feedback-status--error {
      color: #c53030;
    }

    @media (prefers-color-scheme: dark) {
      .feedback-status--error { color: #fc8181; }
    }

    /* ── Comment section ───────────────────────────────────────────────── */
    .feedback-comment-section,
    .feedback-source-section {
      margin-top: 0.5rem;
    }

    .feedback-comment-toggle {
      cursor: pointer;
      color: var(--accent, #1a56db);
      font-size: 0.82rem;
      font-weight: 600;
      list-style: none;
      user-select: none;
      min-height: 44px;
      display: flex;
      align-items: center;
    }

    .feedback-comment-toggle::-webkit-details-marker { display: none; }

    .feedback-comment-toggle:focus-visible {
      outline: 2px solid transparent;
      box-shadow: 0 0 0 3px rgba(26,86,219,.22);
      border-radius: 4px;
    }

    .feedback-textarea {
      font: inherit;
      width: 100%;
      padding: 0.55rem 0.75rem;
      border: 1.5px solid var(--border, #c8d3df);
      border-radius: calc(var(--radius, 14px) - 4px);
      background: var(--bg, #f0f4f8);
      color: var(--fg, #0d1117);
      font-size: 0.9rem;
      resize: vertical;
      min-height: 4rem;
      margin-top: 0.25rem;
      box-sizing: border-box;
    }

    .feedback-textarea:focus {
      outline: 2px solid transparent;
      border-color: var(--accent, #1a56db);
      box-shadow: 0 0 0 3px rgba(26,86,219,.22);
    }

    @media (prefers-color-scheme: dark) {
      .feedback-textarea { background: #0d1525; }
    }

    .feedback-char-count {
      font-size: 0.75rem;
      color: var(--muted, #4a5568);
      display: block;
      text-align: right;
      margin: 0.15rem 0 0.4rem;
    }

    /* ── Source flag ───────────────────────────────────────────────────── */
    .feedback-source-row {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
      align-items: center;
      margin-top: 0.25rem;
    }

    .feedback-source-select {
      font: inherit;
      min-height: 44px;
      padding: 0.45rem 0.75rem;
      border: 1.5px solid var(--border, #c8d3df);
      border-radius: 999px;
      background: var(--card, #fff);
      color: var(--fg, #0d1117);
      font-size: 0.85rem;
      max-width: 100%;
      flex: 1 1 12rem;
    }

    .feedback-source-select:focus {
      outline: 2px solid transparent;
      border-color: var(--accent, #1a56db);
      box-shadow: 0 0 0 3px rgba(26,86,219,.22);
    }

    @media (prefers-color-scheme: dark) {
      .feedback-source-select { background: var(--card, #111827); }
    }

    /* ── Per-item flag button ──────────────────────────────────────────── */
    .item-flag-row {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.35rem 0.5rem 0.5rem 1.5rem;
    }

    .item-flag-btn {
      font: inherit;
      min-height: 44px;
      padding: 0.3rem 0.7rem;
      border: 1.5px solid var(--border, #c8d3df);
      border-radius: 999px;
      background: transparent;
      color: var(--muted, #4a5568);
      cursor: pointer;
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.01em;
      transition: background 160ms, border-color 160ms, color 160ms;
    }

    .item-flag-btn:hover:not(:disabled) {
      border-color: #b03a2e;
      color: #b03a2e;
      background: rgba(176,58,46,.06);
    }

    @media (prefers-color-scheme: dark) {
      .item-flag-btn:hover:not(:disabled) {
        border-color: #f1948a;
        color: #f1948a;
        background: rgba(241,148,138,.08);
      }
    }

    .item-flag-btn:focus-visible {
      outline: 2px solid transparent;
      box-shadow: 0 0 0 3px rgba(26,86,219,.22);
      border-radius: 999px;
    }

    .item-flag-btn:disabled { opacity: 0.45; cursor: default; }
  `;
  document.head.appendChild(style);
}

function mountPanel(slotEl: HTMLElement, digest: Digest): void {
  injectStyles();
  mountFeedbackControls(slotEl, digest, getSupabase());
}

function mountItemFlags(card: HTMLElement, digest: Digest): void {
  mountItemFlagButtons(card, digest, getSupabase());
}

/** Wire feedback controls into the digest-card render hooks. Idempotent. */
export function registerFeedback(): void {
  registerFeedbackSlotMounter(mountPanel);
  registerItemFlagMounter(mountItemFlags);
}

// Auto-register on import so main.ts only needs a single import line.
registerFeedback();
