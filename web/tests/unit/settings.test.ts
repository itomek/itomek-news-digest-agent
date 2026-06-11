// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TtsPlayer, savePrefs } from "../../src/lib/tts";
import { buildSettingsControls } from "../../src/components/settings";

// --- speechSynthesis stub ---------------------------------------------------

interface FakeUtterance {
  text: string;
  rate: number;
  voice: SpeechSynthesisVoice | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

class FakeSynth {
  spoken: FakeUtterance[] = [];
  paused = false;
  cancelled = 0;
  private voices: SpeechSynthesisVoice[] = [];

  speak(u: FakeUtterance): void {
    this.spoken.push(u);
  }
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
  }
  cancel(): void {
    this.cancelled += 1;
  }
  getVoices(): SpeechSynthesisVoice[] {
    return this.voices;
  }
  // expose for tests that inject voices
  __setVoices(v: SpeechSynthesisVoice[]): void {
    this.voices = v;
  }
}

function fakeUtteranceFactory(text: string): FakeUtterance {
  return { text, rate: 1, voice: null, onend: null, onerror: null };
}

function makePlayer(synth: FakeSynth): TtsPlayer {
  return new TtsPlayer({
    synth: synth as unknown as SpeechSynthesis,
    createUtterance: fakeUtteranceFactory as unknown as (t: string) => SpeechSynthesisUtterance,
  });
}

beforeEach(() => {
  localStorage.clear();
  // Install a minimal speechSynthesis stub on window so populateVoices doesn't crash.
  const synth = new FakeSynth();
  Object.defineProperty(globalThis, "speechSynthesis", {
    value: synth,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe("buildSettingsControls", () => {
  it("returns an element with a .tts-voice select and input.tts-rate", () => {
    const player = makePlayer(new FakeSynth());
    const el = buildSettingsControls(player);
    expect(el.querySelector("select.tts-voice")).toBeTruthy();
    expect(el.querySelector("input.tts-rate")).toBeTruthy();
  });

  it("rate slider reflects loadPrefs() value and label shows it", () => {
    savePrefs({ rate: 1.8 });
    const player = makePlayer(new FakeSynth());
    const el = buildSettingsControls(player);
    const slider = el.querySelector<HTMLInputElement>("input.tts-rate");
    expect(slider).toBeTruthy();
    expect(Number(slider!.value)).toBeCloseTo(1.8);
    // label text should include the rate value
    const label = el.querySelector<HTMLElement>(".tts-rate-label");
    expect(label?.textContent).toContain("1.8");
  });

  it("rate slider has correct aria-label, min, max, step attributes", () => {
    const player = makePlayer(new FakeSynth());
    const el = buildSettingsControls(player);
    const slider = el.querySelector<HTMLInputElement>("input.tts-rate")!;
    expect(slider.getAttribute("aria-label")).toBe("Speech rate");
    expect(slider.min).toBe("0.5");
    expect(slider.max).toBe("2");
    expect(slider.step).toBe("0.1");
  });

  it("voice select has correct aria-label", () => {
    const player = makePlayer(new FakeSynth());
    const el = buildSettingsControls(player);
    const select = el.querySelector<HTMLSelectElement>("select.tts-voice")!;
    expect(select.getAttribute("aria-label")).toBe("Voice");
  });

  it("dispatching input on rate slider calls player.setRate and updates localStorage", () => {
    const synth = new FakeSynth();
    const player = makePlayer(synth);
    const setRateSpy = vi.spyOn(player, "setRate");

    const el = buildSettingsControls(player);
    document.body.appendChild(el);

    const slider = el.querySelector<HTMLInputElement>("input.tts-rate")!;
    slider.value = "1.5";
    slider.dispatchEvent(new Event("input", { bubbles: true }));

    expect(setRateSpy).toHaveBeenCalledWith(1.5);
    expect(Number(localStorage.getItem("tts.rate"))).toBeCloseTo(1.5);

    document.body.removeChild(el);
  });

  it("dispatching change on voice select calls player.setVoiceURI and updates localStorage", () => {
    const synth = new FakeSynth();
    const player = makePlayer(synth);
    const setVoiceSpy = vi.spyOn(player, "setVoiceURI");

    const el = buildSettingsControls(player);
    document.body.appendChild(el);

    const select = el.querySelector<HTMLSelectElement>("select.tts-voice")!;
    // Add an option with a real voiceURI value so we can select it
    const opt = document.createElement("option");
    opt.value = "com.example.voice.Daniel";
    opt.textContent = "Daniel";
    select.appendChild(opt);
    select.value = "com.example.voice.Daniel";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    expect(setVoiceSpy).toHaveBeenCalledWith("com.example.voice.Daniel");
    expect(localStorage.getItem("tts.voiceURI")).toBe("com.example.voice.Daniel");

    document.body.removeChild(el);
  });

  it("selecting empty voice value calls setVoiceURI(null)", () => {
    const synth = new FakeSynth();
    const player = makePlayer(synth);
    const setVoiceSpy = vi.spyOn(player, "setVoiceURI");

    const el = buildSettingsControls(player);
    document.body.appendChild(el);

    const select = el.querySelector<HTMLSelectElement>("select.tts-voice")!;
    select.value = "";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    expect(setVoiceSpy).toHaveBeenCalledWith(null);

    document.body.removeChild(el);
  });

  it("rate slider input updates label text live", () => {
    const player = makePlayer(new FakeSynth());
    const el = buildSettingsControls(player);
    document.body.appendChild(el);

    const slider = el.querySelector<HTMLInputElement>("input.tts-rate")!;
    const label = el.querySelector<HTMLElement>(".tts-rate-label")!;
    slider.value = "2.0";
    slider.dispatchEvent(new Event("input", { bubbles: true }));

    expect(label.textContent).toContain("2.0");

    document.body.removeChild(el);
  });

  it("reflects stored voiceURI in the select when voice list already available", () => {
    savePrefs({ voiceURI: "com.example.Samantha" });
    // Populate speechSynthesis with a matching voice
    const synth = new FakeSynth();
    const fakeVoice = {
      voiceURI: "com.example.Samantha",
      name: "Samantha",
      lang: "en-US",
      localService: true,
      default: false,
    } as SpeechSynthesisVoice;
    synth.__setVoices([fakeVoice]);
    Object.defineProperty(globalThis, "speechSynthesis", {
      value: synth,
      configurable: true,
      writable: true,
    });

    const player = makePlayer(synth);
    const el = buildSettingsControls(player);

    const select = el.querySelector<HTMLSelectElement>("select.tts-voice")!;
    expect(select.value).toBe("com.example.Samantha");
  });
});

// --- active-backend voices (#63) ---------------------------------------------

/** Minimal TtsBackend whose voices stand in for a neural endpoint's ids. */
class FakeNeuralBackend {
  supportsRealSeek = true;
  maxChunkChars = 4000;
  voices: { id: string; label: string }[] = [
    { id: "en-US-Chirp3-HD-Aoede", label: "Aoede" },
    { id: "en-US-Chirp3-HD-Puck", label: "Puck" },
  ];
  async = false;
  speak(_t: string, _o: { rate: number; voiceURI: string | null }, _end: () => void): void {}
  pause(): void {}
  resume(): void {}
  cancel(): void {}
  listVoices(): { id: string; label: string }[] | Promise<{ id: string; label: string }[]> {
    return this.async ? Promise.resolve(this.voices) : this.voices;
  }
}

describe("buildSettingsControls with a neural backend", () => {
  it("lists the active backend's voices instead of speechSynthesis voices", () => {
    // speechSynthesis (installed by beforeEach) has NO voices; the backend does.
    const backend = new FakeNeuralBackend();
    const player = new TtsPlayer({ backend });
    const el = buildSettingsControls(player);
    const select = el.querySelector<HTMLSelectElement>("select.tts-voice")!;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toContain("en-US-Chirp3-HD-Aoede");
    expect(values).toContain("en-US-Chirp3-HD-Puck");
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toContain("Aoede");
    expect(labels).toContain("Puck");
  });

  it("populates asynchronously when listVoices returns a promise", async () => {
    const backend = new FakeNeuralBackend();
    backend.async = true;
    const player = new TtsPlayer({ backend });
    const el = buildSettingsControls(player);
    const select = el.querySelector<HTMLSelectElement>("select.tts-voice")!;
    await new Promise((r) => setTimeout(r, 0));
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toContain("en-US-Chirp3-HD-Aoede");
  });

  it("persists a selected neural voice id via prefs", () => {
    const backend = new FakeNeuralBackend();
    const player = new TtsPlayer({ backend });
    const el = buildSettingsControls(player);
    document.body.appendChild(el);

    const select = el.querySelector<HTMLSelectElement>("select.tts-voice")!;
    select.value = "en-US-Chirp3-HD-Puck";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    expect(localStorage.getItem("tts.voiceURI")).toBe("en-US-Chirp3-HD-Puck");
    expect(player.getVoiceURI()).toBe("en-US-Chirp3-HD-Puck");

    document.body.removeChild(el);
  });

  it("pre-selects the stored neural voice id when it exists in the list", () => {
    savePrefs({ voiceURI: "en-US-Chirp3-HD-Puck" });
    const backend = new FakeNeuralBackend();
    const player = new TtsPlayer({ backend });
    const el = buildSettingsControls(player);
    const select = el.querySelector<HTMLSelectElement>("select.tts-voice")!;
    expect(select.value).toBe("en-US-Chirp3-HD-Puck");
  });

  it("falls back to the default option when the stored id is not in the active backend's list", () => {
    savePrefs({ voiceURI: "com.example.Samantha" }); // an OS voice id, not a neural one
    const backend = new FakeNeuralBackend();
    const player = new TtsPlayer({ backend });
    const el = buildSettingsControls(player);
    const select = el.querySelector<HTMLSelectElement>("select.tts-voice")!;
    expect(select.value).toBe(""); // "Default voice"
  });
});
