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
import { TtsPlayer, type TtsItem, type TtsState } from "../lib/tts";
import { buildSettingsControls } from "./settings";

let player: TtsPlayer | null = null;
// Ordered registry: insertion order === card render order.
const registry = new Map<string, { digest: Digest; card: HTMLElement }>();
// All digests ever mounted, keyed by id, so finalize can resolve content even
// after a re-render. Card refs are resolved live from the DOM at finalize time.
const knownDigests = new Map<string, Digest>();
let playAllBtn: HTMLButtonElement | null = null;
let finalizeScheduled = false;

function getPlayer(): TtsPlayer {
  if (player) return player;
  player = new TtsPlayer({ onStateChange: handleStateChange });
  return player;
}

function setCardState(cardEl: HTMLElement, state: TtsState): void {
  cardEl.setAttribute("data-tts-state", state);
  const playBtn = cardEl.querySelector<HTMLButtonElement>(".tts-play");
  const pauseBtn = cardEl.querySelector<HTMLButtonElement>(".tts-pause");
  if (playBtn) playBtn.disabled = state === "playing";
  if (pauseBtn) {
    // Pause doubles as Resume while paused, so it stays enabled unless idle.
    pauseBtn.disabled = state === "idle";
    pauseBtn.textContent = state === "paused" ? "Resume" : "Pause";
  }
}

function handleStateChange(state: TtsState, currentId: string | null): void {
  // Reset all cards, then mark the active one.
  for (const [id, { card }] of registry) {
    setCardState(card, state !== "idle" && id === currentId ? state : "idle");
  }
  if (playAllBtn) {
    playAllBtn.setAttribute("aria-pressed", String(state !== "idle"));
  }
}

function injectStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById("tts-styles")) return;
  const style = document.createElement("style");
  style.id = "tts-styles";
  style.textContent = `
    .tts-controls { display:flex; flex-wrap:wrap; gap:0.4rem; align-items:center; margin-bottom:0.6rem; }
    .tts-controls button { min-height:44px; padding:0.4rem 0.7rem; font-size:0.9rem; }
    .tts-playall { display:flex; align-items:center; gap:0.5rem; margin:0 0 1rem; }
    .tts-playall button[aria-pressed="true"] { background: var(--card); color: var(--accent); }
    .digest-card[data-tts-state="playing"] { outline:2px solid var(--accent); outline-offset:2px; }
    .digest-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:0.6rem; padding:0.5rem 0 0.75rem; border-bottom:1px solid var(--border); margin-bottom:1rem; }
    .tts-settings { display:flex; flex-wrap:wrap; gap:0.4rem; align-items:center; }
    .tts-settings select.tts-voice { font:inherit; min-height:44px; max-width:9rem; border:1px solid var(--border); border-radius:var(--radius); background:var(--bg); color:var(--fg); padding:0 0.4rem; }
    .tts-settings input.tts-rate { accent-color: var(--accent); min-height:44px; }
    .tts-rate-label { font-size:0.8rem; color:var(--muted); white-space:nowrap; }
  `;
  document.head.appendChild(style);
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
// play-all bar. Runs in a microtask after the synchronous render batch, so the
// cards are attached and querySelectorAll reflects true DOM order.
function finalize(): void {
  finalizeScheduled = false;
  if (typeof document === "undefined") return;

  registry.clear();
  const cards = document.querySelectorAll<HTMLElement>(".digest-card");
  let firstSlot: HTMLElement | null = null;
  for (const card of cards) {
    const id = card.getAttribute("data-digest-id");
    if (!id) continue;
    const digest = knownDigests.get(id);
    if (!digest) continue;
    registry.set(id, { digest, card });
    if (!firstSlot) firstSlot = card.querySelector<HTMLElement>(".playback-slot");
  }

  // Drop any stale play-all bar, then mount exactly one above the first card.
  document.querySelectorAll(".tts-playall").forEach((el) => el.remove());
  playAllBtn = null;
  if (firstSlot) firstSlot.prepend(buildPlayAllBar());

  // Mount a single global settings toolbar above the digest list.
  document.querySelectorAll(".digest-toolbar").forEach((el) => el.remove());
  const digestList = document.querySelector<HTMLElement>(".digest-list");
  if (digestList) {
    const toolbar = document.createElement("div");
    toolbar.className = "digest-toolbar";
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

  const play = makeButton("Play", "tts-play");
  const pause = makeButton("Pause", "tts-pause");
  pause.disabled = true;
  const stop = makeButton("Stop", "tts-stop");
  const skip = makeButton("Skip 30s", "tts-skip");

  play.addEventListener("click", () => {
    const p = getPlayer();
    // First speak fires here, inside the user gesture — required for iOS.
    p.play([{ id: digest.id, text: digest.content }]);
  });
  pause.addEventListener("click", () => {
    const p = getPlayer();
    if (p.getState() === "paused") p.resume();
    else p.pause();
  });
  stop.addEventListener("click", () => getPlayer().stop());
  skip.addEventListener("click", () => getPlayer().skip(30));

  controls.append(play, pause, stop, skip);
  slot.appendChild(controls);
}

/** Wire playback controls into the digest-card render hook. Idempotent. */
export function registerPlaybackControls(): void {
  registerCardHook(mountControls);
}

// Auto-register on import so main.ts only needs a single import line.
registerPlaybackControls();
