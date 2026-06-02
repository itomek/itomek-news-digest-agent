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
import { TtsPlayer, type TtsItem, type TtsState, loadPrefs } from "../lib/tts";

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
    .tts-controls button { min-height:40px; padding:0.4rem 0.7rem; font-size:0.9rem; }
    .tts-controls .tts-prefs { display:flex; gap:0.4rem; align-items:center; margin-left:auto; }
    .tts-controls select.tts-voice { font:inherit; min-height:40px; max-width:9rem; border:1px solid var(--border); border-radius:var(--radius); background:var(--bg); color:var(--fg); padding:0 0.4rem; }
    .tts-controls input.tts-rate { accent-color: var(--accent); }
    .tts-rate-label { font-size:0.8rem; color:var(--muted); white-space:nowrap; }
    .tts-playall { display:flex; align-items:center; gap:0.5rem; margin:0 0 1rem; }
    .tts-playall button[aria-pressed="true"] { background: var(--card); color: var(--accent); }
    .digest-card[data-tts-state="playing"] { outline:2px solid var(--accent); outline-offset:2px; }
  `;
  document.head.appendChild(style);
}

function populateVoices(select: HTMLSelectElement): void {
  const synth = (globalThis as unknown as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
  if (!synth) return;
  const render = (): void => {
    const voices = synth.getVoices();
    const current = loadPrefs().voiceURI;
    select.replaceChildren();
    const def = document.createElement("option");
    def.value = "";
    def.textContent = "Default voice";
    select.appendChild(def);
    for (const v of voices) {
      const opt = document.createElement("option");
      opt.value = v.voiceURI;
      opt.textContent = v.name;
      if (current && (v.voiceURI === current || v.name === current)) opt.selected = true;
      select.appendChild(opt);
    }
  };
  render();
  // Voices often load asynchronously.
  if (typeof synth.addEventListener === "function") {
    synth.addEventListener("voiceschanged", render);
  }
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

  // Voice + rate prefs (shared across cards, but each card carries a copy so the
  // controls are reachable per-card).
  const prefs = document.createElement("div");
  prefs.className = "tts-prefs";

  const voice = document.createElement("select");
  voice.className = "tts-voice";
  voice.setAttribute("aria-label", "Voice");
  populateVoices(voice);
  voice.addEventListener("change", () => {
    getPlayer().setVoiceURI(voice.value || null);
  });

  const rateLabel = document.createElement("label");
  rateLabel.className = "tts-rate-label";
  const rate = document.createElement("input");
  rate.type = "range";
  rate.className = "tts-rate";
  rate.min = "0.5";
  rate.max = "2";
  rate.step = "0.1";
  const stored = loadPrefs().rate;
  rate.value = String(stored);
  rateLabel.textContent = `Speed ${stored.toFixed(1)}x`;
  rate.setAttribute("aria-label", "Speech rate");
  rate.addEventListener("input", () => {
    const r = Number(rate.value);
    rateLabel.textContent = `Speed ${r.toFixed(1)}x`;
    getPlayer().setRate(r);
  });

  rateLabel.appendChild(rate);
  prefs.append(voice, rateLabel);
  controls.appendChild(prefs);

  slot.appendChild(controls);
}

/** Wire playback controls into the digest-card render hook. Idempotent. */
export function registerPlaybackControls(): void {
  registerCardHook(mountControls);
}

// Auto-register on import so main.ts only needs a single import line.
registerPlaybackControls();
