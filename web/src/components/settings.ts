// Global TTS settings controls (voice selector + speed slider).
//
// Mounted once at page level in a `.digest-toolbar`, not per-card. This module
// owns the voice-list UI (including async `voiceschanged` repopulation) that was
// previously duplicated inside every card via `populateVoices` in playback.ts.

import { type TtsPlayer, loadPrefs } from "../lib/tts";

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
  // Voices often load asynchronously — re-render when the list arrives.
  if (typeof synth.addEventListener === "function") {
    synth.addEventListener("voiceschanged", render);
  }
}

/**
 * Build a `.tts-settings` element containing a global voice `<select>` and
 * speed `<input type="range">`. Reads `loadPrefs()` to reflect stored values
 * and delegates persistence to the player's `setRate`/`setVoiceURI` (which
 * call `savePrefs` internally).
 *
 * Idempotent to mount: caller is responsible for removing any prior instance.
 */
export function buildSettingsControls(player: TtsPlayer): HTMLElement {
  const group = document.createElement("div");
  group.className = "tts-settings";

  // Voice selector
  const voice = document.createElement("select");
  voice.className = "tts-voice";
  voice.setAttribute("aria-label", "Voice");
  populateVoices(voice);
  voice.addEventListener("change", () => {
    player.setVoiceURI(voice.value || null);
  });

  // Speed slider — use a separate <span> for the text so updating it never
  // risks detaching the <input> from the label DOM subtree.
  const rateLabel = document.createElement("label");
  rateLabel.className = "tts-rate-label";

  const rateLabelText = document.createElement("span");

  const rate = document.createElement("input");
  rate.type = "range";
  rate.className = "tts-rate";
  rate.min = "0.5";
  rate.max = "2";
  rate.step = "0.1";
  rate.setAttribute("aria-label", "Speech rate");

  const stored = loadPrefs().rate;
  rate.value = String(stored);
  rateLabelText.textContent = `Speed ${stored.toFixed(1)}x`;

  rate.addEventListener("input", () => {
    const r = Number(rate.value);
    rateLabelText.textContent = `Speed ${r.toFixed(1)}x`;
    player.setRate(r);
  });

  rateLabel.append(rate, rateLabelText);
  group.append(voice, rateLabel);

  return group;
}
