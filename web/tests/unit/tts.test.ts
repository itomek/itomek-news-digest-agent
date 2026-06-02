// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TtsPlayer,
  chunkText,
  loadPrefs,
  savePrefs,
  stripFormatting,
  wordsForSkip,
} from "../../src/lib/tts";

// --- speechSynthesis stub -------------------------------------------------

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
  private current: FakeUtterance | null = null;

  speak(u: FakeUtterance): void {
    this.spoken.push(u);
    this.current = u;
    this.paused = false;
  }
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
  }
  cancel(): void {
    this.cancelled += 1;
    this.current = null;
  }
  // test helper: fire onend of the most recent utterance
  finishCurrent(): void {
    const u = this.current;
    this.current = null;
    u?.onend?.();
  }
  getVoices(): SpeechSynthesisVoice[] {
    return [];
  }
}

function fakeUtteranceFactory(text: string): FakeUtterance {
  return { text, rate: 1, voice: null, onend: null, onerror: null };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- stripFormatting ------------------------------------------------------

describe("stripFormatting", () => {
  it("removes bold/italic markers but keeps the words", () => {
    expect(stripFormatting("This is **bold** and *italic* and _under_.")).toBe(
      "This is bold and italic and under.",
    );
  });

  it("strips markdown headers", () => {
    expect(stripFormatting("## Big News\nBody text")).toBe("Big News\nBody text");
  });

  it("strips list markers", () => {
    const out = stripFormatting("- first\n- second\n1. third");
    expect(out).toContain("first");
    expect(out).toContain("second");
    expect(out).toContain("third");
    expect(out).not.toMatch(/^- /m);
    expect(out).not.toMatch(/^\d+\.\s/m);
  });

  it("turns links into their visible text", () => {
    expect(stripFormatting("See [the report](https://example.com/x) today")).toBe(
      "See the report today",
    );
  });

  it("removes inline code backticks and blockquote markers", () => {
    expect(stripFormatting("Run `npm test` now")).toBe("Run npm test now");
    expect(stripFormatting("> quoted line")).toBe("quoted line");
  });

  it("leaves no stray markdown punctuation that TTS would read aloud", () => {
    const out = stripFormatting("### **Title** — `code` [link](http://x) *em*");
    expect(out).not.toMatch(/[#*_`]/);
    expect(out).not.toContain("http://x");
  });
});

// --- chunkText ------------------------------------------------------------

describe("chunkText", () => {
  it("returns a single chunk for short text", () => {
    expect(chunkText("Hello world.", 200)).toEqual(["Hello world."]);
  });

  it("splits long text into <= max-length chunks on sentence boundaries", () => {
    const sentence = "This is a sentence that is reasonably long. ";
    const text = sentence.repeat(20).trim();
    const chunks = chunkText(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(200);
      expect(c.trim().length).toBeGreaterThan(0);
    }
  });

  it("preserves all words when rejoined", () => {
    const text =
      "Alpha beta gamma delta. Epsilon zeta eta theta! Iota kappa lambda mu? Nu xi omicron pi.";
    const chunks = chunkText(text, 40);
    const rejoined = chunks.join(" ").replace(/\s+/g, " ").trim();
    const original = text.replace(/\s+/g, " ").trim();
    expect(rejoined).toBe(original);
  });

  it("splits a single over-long sentence so no chunk exceeds max", () => {
    const text = "word ".repeat(100).trim(); // 500 chars, no sentence boundary
    const chunks = chunkText(text, 100);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(100);
    }
  });

  it("ignores empty input", () => {
    expect(chunkText("", 200)).toEqual([]);
    expect(chunkText("   ", 200)).toEqual([]);
  });
});

// --- prefs ----------------------------------------------------------------

describe("prefs persistence", () => {
  it("defaults to rate 1.2 and no voice when nothing stored", () => {
    const prefs = loadPrefs();
    expect(prefs.rate).toBeCloseTo(1.2);
    expect(prefs.voiceURI).toBeNull();
  });

  it("round-trips voice and rate through localStorage", () => {
    savePrefs({ rate: 1.5, voiceURI: "Daniel" });
    const prefs = loadPrefs();
    expect(prefs.rate).toBe(1.5);
    expect(prefs.voiceURI).toBe("Daniel");
    expect(localStorage.getItem("tts.rate")).toBe("1.5");
    expect(localStorage.getItem("tts.voiceURI")).toBe("Daniel");
  });

  it("falls back to default rate when the stored value is garbage", () => {
    localStorage.setItem("tts.rate", "not-a-number");
    expect(loadPrefs().rate).toBeCloseTo(1.2);
  });
});

// --- skip math ------------------------------------------------------------

describe("wordsForSkip", () => {
  it("computes words for a 30s skip at rate 1.2 (~90 words)", () => {
    // baseline 150 wpm * rate, over 30s => 150*1.2/60*30 = 90
    expect(wordsForSkip(1.2, 30)).toBe(90);
  });

  it("scales with rate", () => {
    expect(wordsForSkip(1.0, 30)).toBe(75);
    expect(wordsForSkip(2.0, 30)).toBe(150);
  });
});

// --- TtsPlayer queue ------------------------------------------------------

describe("TtsPlayer queue", () => {
  function makePlayer(synth: FakeSynth) {
    return new TtsPlayer({
      synth: synth as unknown as SpeechSynthesis,
      createUtterance: fakeUtteranceFactory as unknown as (t: string) => SpeechSynthesisUtterance,
    });
  }

  it("speaks the first chunk on play and advances through chunks on onend", () => {
    const synth = new FakeSynth();
    const player = makePlayer(synth);
    // Two short items, each one chunk.
    player.play([
      { id: "a", text: "First digest." },
      { id: "b", text: "Second digest." },
    ]);
    expect(synth.spoken.length).toBe(1);
    expect(synth.spoken[0].text).toContain("First digest");

    synth.finishCurrent();
    expect(synth.spoken.length).toBe(2);
    expect(synth.spoken[1].text).toContain("Second digest");

    synth.finishCurrent();
    // queue exhausted, no more speaks
    expect(synth.spoken.length).toBe(2);
    expect(player.isPlaying()).toBe(false);
  });

  it("walks every chunk of a multi-chunk item before the next item", () => {
    const synth = new FakeSynth();
    const player = makePlayer(synth);
    const long = "Sentence one is here. ".repeat(20).trim(); // many chunks
    player.play([{ id: "a", text: long }, { id: "b", text: "Tail." }]);
    let guard = 0;
    while (synth.spoken[synth.spoken.length - 1].text !== "Tail." && guard < 100) {
      synth.finishCurrent();
      guard += 1;
    }
    expect(synth.spoken[synth.spoken.length - 1].text).toBe("Tail.");
    expect(synth.spoken.length).toBeGreaterThan(2);
  });

  it("stop cancels synthesis and clears the queue", () => {
    const synth = new FakeSynth();
    const player = makePlayer(synth);
    player.play([{ id: "a", text: "Hello there friend." }]);
    player.stop();
    expect(synth.cancelled).toBeGreaterThan(0);
    expect(player.isPlaying()).toBe(false);
  });

  it("pause and resume map to the synth", () => {
    const synth = new FakeSynth();
    const player = makePlayer(synth);
    player.play([{ id: "a", text: "Hello there friend." }]);
    player.pause();
    expect(synth.paused).toBe(true);
    player.resume();
    expect(synth.paused).toBe(false);
  });

  it("strips formatting from item text before speaking", () => {
    const synth = new FakeSynth();
    const player = makePlayer(synth);
    player.play([{ id: "a", text: "## Heading\n**Bold** point." }]);
    const allSpoken = synth.spoken.map((u) => u.text).join(" ");
    expect(allSpoken).not.toMatch(/[#*]/);
    expect(allSpoken).toContain("Heading");
    expect(allSpoken).toContain("Bold point");
  });

  it("skip advances within the current item by the computed word count", () => {
    const synth = new FakeSynth();
    const player = makePlayer(synth);
    // 200 words, single item; at rate 1.2 a 30s skip ~ 90 words.
    const words = Array.from({ length: 200 }, (_, i) => `w${i}`).join(" ") + ".";
    player.setRate(1.2);
    player.play([{ id: "a", text: words }]);
    const before = synth.spoken.length;
    player.skip(30);
    expect(synth.spoken.length).toBeGreaterThan(before);
    // After skipping ~90 words, the freshly spoken chunk should start near w90,
    // not back at w0.
    const latest = synth.spoken[synth.spoken.length - 1].text;
    expect(latest).not.toContain("w0 ");
    expect(latest).toMatch(/w(8[5-9]|9[0-5])/);
  });
});
