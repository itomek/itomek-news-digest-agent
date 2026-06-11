// Per-digest playback controls + a "play all today" control (#11).
//
// Mounts into each card's `.playback-slot` via the hook #10 left in
// views/digest-card.ts. A single shared TtsPlayer drives all cards; an ordered
// registry of mounted digests powers "Play all today" (DOM/registration order,
// which is newest-first by topic+date from digest-list.ts).
//
// This module is self-contained: it injects its own scoped styles and
// auto-registers on import, so main.ts only needs a single import line.

import { registerPlaybackControls as registerCardHook } from "../views/digest-card";
import type { Digest } from "../lib/types";
import { TtsPlayer, type TtsItem, type TtsState, wordsForSkip } from "../lib/tts";
import { buildSettingsControls } from "./settings";

let player: TtsPlayer | null = null;
// Ordered registry: insertion order === card render order.
const registry = new Map<string, { digest: Digest; card: HTMLElement }>();
// All digests ever mounted, keyed by id, so finalize can resolve content even
// after a re-render. Card refs are resolved live from the DOM at finalize time.
const knownDigests = new Map<string, Digest>();
let playAllBtn: HTMLButtonElement | null = null;
let finalizeScheduled = false;

// --- progress timer state ---------------------------------------------------

interface ProgressState {
  timerId: ReturnType<typeof setInterval> | null;
  elapsed: number;    // seconds elapsed since play started
  total: number;      // estimated total seconds for active item
  activeId: string | null;
}

const progress: ProgressState = {
  timerId: null,
  elapsed: 0,
  total: 0,
  activeId: null,
};

const TICK_MS = 500;

function estimateTotal(digest: Digest): number {
  const words = digest.content.trim().split(/\s+/).filter(Boolean).length;
  const rate = getPlayer().getRate();
  // wordsForSkip(rate, 1) = words spoken per second at this rate
  const wps = wordsForSkip(rate, 1);
  return wps > 0 ? words / wps : 0;
}

function setProgressFill(digestId: string, fraction: number): void {
  const entry = registry.get(digestId);
  if (!entry) return;
  const fill = entry.card.querySelector<HTMLElement>(".tts-progress-fill");
  if (!fill) return;
  fill.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
}

function resetProgress(digestId: string | null): void {
  if (digestId) setProgressFill(digestId, 0);
  progress.elapsed = 0;
  progress.total = 0;
}

function stopTicker(): void {
  if (progress.timerId !== null) {
    clearInterval(progress.timerId);
    progress.timerId = null;
  }
}

function startTicker(digestId: string): void {
  stopTicker();
  const digest = knownDigests.get(digestId);
  if (!digest) return;
  progress.activeId = digestId;
  progress.elapsed = 0;
  progress.total = estimateTotal(digest);
  progress.timerId = setInterval(() => {
    progress.elapsed += TICK_MS / 1000;
    setProgressFill(digestId, progress.total > 0 ? progress.elapsed / progress.total : 0);
  }, TICK_MS);
}

// ---------------------------------------------------------------------------

function getPlayer(): TtsPlayer {
  if (player) return player;
  player = new TtsPlayer({ onStateChange: handleStateChange });
  return player;
}

function setCardState(cardEl: HTMLElement, state: TtsState): void {
  cardEl.setAttribute("data-tts-state", state);
  const toggleBtn = cardEl.querySelector<HTMLButtonElement>(".tts-toggle");
  const stopBtn = cardEl.querySelector<HTMLButtonElement>(".tts-stop");
  const skipBtn = cardEl.querySelector<HTMLButtonElement>(".tts-skip");

  if (toggleBtn) {
    const isPlaying = state === "playing";
    const isActive = isPlaying || state === "paused";
    toggleBtn.setAttribute("aria-pressed", String(isActive));
    toggleBtn.setAttribute("aria-label", isPlaying ? "Pause" : "Play");
    toggleBtn.innerHTML = isPlaying ? ICON_PAUSE : ICON_PLAY;
    toggleBtn.disabled = false;
  }
  if (stopBtn) stopBtn.disabled = state === "idle";
  if (skipBtn) skipBtn.disabled = state === "idle";
}

function handleStateChange(state: TtsState, currentId: string | null): void {
  // If the active card changed, clear timer and reset the previous card's fill.
  if (progress.activeId && progress.activeId !== currentId) {
    stopTicker();
    resetProgress(progress.activeId);
    progress.activeId = null;
  }

  // Reset all cards, then mark the active one.
  for (const [id, { card }] of registry) {
    const cardState = state !== "idle" && id === currentId ? state : "idle";
    setCardState(card, cardState);
    if (cardState === "idle") {
      const fill = card.querySelector<HTMLElement>(".tts-progress-fill");
      if (fill) fill.style.width = "0%";
    }
  }

  if (playAllBtn) {
    playAllBtn.setAttribute("aria-pressed", String(state !== "idle"));
  }

  // Manage progress ticker based on new state.
  if (currentId && state === "playing") {
    if (progress.activeId !== currentId) {
      resetProgress(progress.activeId);
      startTicker(currentId);
    } else if (progress.timerId === null) {
      // Resuming the same item — restart ticker without resetting elapsed.
      const digest = knownDigests.get(currentId);
      if (digest) progress.total = estimateTotal(digest);
      progress.timerId = setInterval(() => {
        progress.elapsed += TICK_MS / 1000;
        setProgressFill(currentId, progress.total > 0 ? progress.elapsed / progress.total : 0);
      }, TICK_MS);
    }
  } else if (state === "paused") {
    stopTicker(); // freeze while paused
  } else if (state === "idle") {
    stopTicker();
    if (currentId) resetProgress(currentId);
    else if (progress.activeId) {
      resetProgress(progress.activeId);
      progress.activeId = null;
    }
  }
}

// --- SVG icon glyphs (aria-hidden; button carries aria-label) ---------------

const ICON_PLAY =
  `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">` +
  `<path d="M4 2.5a.5.5 0 0 1 .765-.424l8 5.5a.5.5 0 0 1 0 .848l-8 5.5A.5.5 0 0 1 4 13.5v-11Z"/>` +
  `</svg>`;
const ICON_PAUSE =
  `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">` +
  `<path d="M5.5 3.5A1.5 1.5 0 0 1 7 5v6a1.5 1.5 0 0 1-3 0V5a1.5 1.5 0 0 1 1.5-1.5Zm5 0A1.5 1.5 0 0 1 12 5v6a1.5 1.5 0 0 1-3 0V5a1.5 1.5 0 0 1 1.5-1.5Z"/>` +
  `</svg>`;
const ICON_STOP =
  `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">` +
  `<path d="M3.5 3.5A1.5 1.5 0 0 1 5 2h6a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 11 14H5a1.5 1.5 0 0 1-1.5-1.5v-9Z"/>` +
  `</svg>`;
const ICON_SKIP =
  `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">` +
  `<path d="M3.5 2.5a.5.5 0 0 1 .5.5v4.06l7.07-4.65A.5.5 0 0 1 12 2.9v10.2a.5.5 0 0 1-.77.42L4.5 8.94V13a.5.5 0 0 1-1 0v-10a.5.5 0 0 1 .5-.5Zm9 0a.5.5 0 0 1 .5.5v10a.5.5 0 0 1-1 0V3a.5.5 0 0 1 .5-.5Z"/>` +
  `</svg>`;

function injectStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById("tts-styles")) return;
  const style = document.createElement("style");
  style.id = "tts-styles";
  style.textContent = `
    /* Per-card icon transport bar */
    .tts-controls {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
      align-items: center;
      margin-bottom: 0.6rem;
    }
    .tts-controls button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 44px;
      min-height: 44px;
      padding: 0.5rem;
      border: 1.5px solid var(--border, #c8d3df);
      border-radius: var(--radius, 8px);
      background: transparent;
      color: var(--fg, #0d1117);
      cursor: pointer;
      line-height: 1;
      transition: background 160ms, border-color 160ms, color 160ms;
    }
    .tts-controls button:hover:not(:disabled) {
      background: var(--accent, #1a56db);
      border-color: var(--accent, #1a56db);
      color: var(--accent-fg, #ffffff);
    }
    .tts-controls button:focus-visible {
      outline: 2px solid var(--accent, #1a56db);
      outline-offset: 2px;
    }
    .tts-controls button:disabled {
      opacity: 0.38;
      cursor: default;
    }
    /* Toggle shows pressed state while playing or paused */
    .tts-controls button.tts-toggle[aria-pressed="true"] {
      background: var(--accent, #1a56db);
      border-color: var(--accent, #1a56db);
      color: var(--accent-fg, #ffffff);
    }
    /* Progress pill */
    .tts-progress {
      flex: 1 1 100%;
      height: 4px;
      border-radius: 2px;
      background: var(--border, #c8d3df);
      overflow: hidden;
      margin-top: 0.1rem;
    }
    .tts-progress-fill {
      height: 100%;
      width: 0%;
      background: var(--accent, #1a56db);
      border-radius: 2px;
      transition: width 500ms linear;
    }
    /* Play-all bar (inside .digest-toolbar) */
    .tts-playall { display:flex; align-items:center; gap:0.5rem; }
    .tts-playall button[aria-pressed="true"] { background: var(--card, #fff); color: var(--accent, #1a56db); }
    /* Active card outline */
    .digest-card[data-tts-state="playing"],
    .digest-card[data-tts-state="paused"] {
      outline: 2px solid var(--accent, #1a56db);
      outline-offset: 2px;
    }
    /* Page-level toolbar housing play-all + settings */
    .digest-toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.6rem;
      padding: 0.5rem 0 0.75rem;
      border-bottom: 1px solid var(--border, #c8d3df);
      margin-bottom: 1rem;
    }
    .digest-toolbar .tts-settings { margin-left: auto; }
    .tts-settings { display:flex; flex-wrap:wrap; gap:0.4rem; align-items:center; }
    .tts-settings select.tts-voice { font:inherit; min-height:44px; max-width:9rem; border:1px solid var(--border, #c8d3df); border-radius:var(--radius, 8px); background:var(--bg, #f0f4f8); color:var(--fg, #0d1117); padding:0 0.4rem; }
    .tts-settings input.tts-rate { accent-color: var(--accent, #1a56db); min-height:44px; }
    .tts-rate-label { font-size:0.8rem; color:var(--muted, #4a5568); white-space:nowrap; }
  `;
  document.head.appendChild(style);
}

function makeIconButton(icon: string, ariaLabel: string, cls: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = cls;
  btn.setAttribute("aria-label", ariaLabel);
  btn.innerHTML = icon;
  return btn;
}

function makeButton(label: string, cls: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = cls;
  btn.textContent = label;
  return btn;
}

function orderedItems(): TtsItem[] {
  return [...registry.values()].map(({ digest }) => ({ id: digest.id, text: digest.content }));
}

// Rebuild the ordered registry from the live DOM and (re)mount a single
// play-all bar + settings toolbar. Runs in a microtask after the synchronous
// render batch, so cards are attached and querySelectorAll reflects true DOM order.
function finalize(): void {
  finalizeScheduled = false;
  if (typeof document === "undefined") return;

  registry.clear();
  const cards = document.querySelectorAll<HTMLElement>(".digest-card");
  for (const card of cards) {
    const id = card.getAttribute("data-digest-id");
    if (!id) continue;
    const digest = knownDigests.get(id);
    if (!digest) continue;
    registry.set(id, { digest, card });
  }

  // Drop any stale play-all bar.
  document.querySelectorAll(".tts-playall").forEach((el) => el.remove());
  playAllBtn = null;

  // Mount a single global toolbar above the digest list: [play-all] … [settings].
  document.querySelectorAll(".digest-toolbar").forEach((el) => el.remove());
  const digestList = document.querySelector<HTMLElement>(".digest-list");
  if (digestList) {
    const toolbar = document.createElement("div");
    toolbar.className = "digest-toolbar";
    toolbar.appendChild(buildPlayAllBar());
    toolbar.appendChild(buildSettingsControls(getPlayer()));
    digestList.prepend(toolbar);
  }
}

function scheduleFinalize(): void {
  if (finalizeScheduled) return;
  finalizeScheduled = true;
  const run = () => finalize();
  if (typeof queueMicrotask === "function") queueMicrotask(run);
  else Promise.resolve().then(run);
}

function buildPlayAllBar(): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "tts-playall";
  const btn = makeButton("Play all today", "tts-playall-btn");
  btn.setAttribute("aria-pressed", "false");
  btn.addEventListener("click", () => {
    getPlayer().play(orderedItems());
  });
  const stopAll = makeButton("Stop", "tts-playall-stop");
  stopAll.addEventListener("click", () => getPlayer().stop());
  bar.append(btn, stopAll);
  playAllBtn = btn;
  return bar;
}

function mountControls(slot: HTMLElement, digest: Digest): void {
  injectStyles();
  knownDigests.set(digest.id, digest);
  // The play-all bar + ordered registry are (re)built once per render batch in a
  // microtask, after all cards are attached to the DOM.
  scheduleFinalize();

  const controls = document.createElement("div");
  controls.className = "tts-controls";

  // Single play/pause toggle replaces the old separate Play + Pause buttons.
  const toggle = makeIconButton(ICON_PLAY, "Play", "tts-toggle");
  toggle.setAttribute("aria-pressed", "false");

  const stop = makeIconButton(ICON_STOP, "Stop", "tts-stop");
  stop.disabled = true;

  const skip = makeIconButton(ICON_SKIP, "Skip 30 seconds", "tts-skip");
  skip.disabled = true;

  toggle.addEventListener("click", () => {
    const p = getPlayer();
    const state = p.getState();
    if (state === "playing") {
      p.pause();
    } else if (state === "paused") {
      p.resume();
    } else {
      // First speak fires inside the user gesture — required for iOS.
      p.play([{ id: digest.id, text: digest.content }]);
    }
  });

  stop.addEventListener("click", () => getPlayer().stop());

  skip.addEventListener("click", () => {
    // Advance the progress estimate optimistically.
    if (progress.activeId === digest.id) {
      progress.elapsed = Math.min(progress.elapsed + 30, progress.total);
      setProgressFill(digest.id, progress.total > 0 ? progress.elapsed / progress.total : 0);
    }
    getPlayer().skip(30);
  });

  // Progress bar.
  const progressEl = document.createElement("div");
  progressEl.className = "tts-progress";
  const progressFill = document.createElement("div");
  progressFill.className = "tts-progress-fill";
  progressEl.appendChild(progressFill);

  controls.append(toggle, stop, skip, progressEl);
  slot.appendChild(controls);
}

/** Wire playback controls into the digest-card render hook. Idempotent. */
export function registerPlaybackControls(): void {
  registerCardHook(mountControls);
}

// Auto-register on import so main.ts only needs a single import line.
registerPlaybackControls();
