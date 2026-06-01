// Web Speech API text-to-speech wrapper for digest playback (#11).
//
// Responsibilities:
//   - Strip markdown/formatting artifacts so the synth never reads "asterisk" etc.
//   - Chunk text on sentence boundaries (~200 chars) to dodge the iOS Safari
//     long-utterance cutoff, where utterances over a few hundred chars get
//     silently truncated.
//   - Maintain a playlist queue; `onend` advances to the next chunk, then the
//     next item.
//   - Persist voice + rate in localStorage (default rate 1.2).
//   - skip-30s: jump forward within the current item by an estimated word count.
//   - iOS: never auto-speak (first speak must come from a user gesture handled by
//     the UI layer); resume on `visibilitychange` since iOS suspends synthesis
//     when the tab/screen backgrounds.

export interface TtsItem {
  id: string;
  text: string;
}

export interface TtsPrefs {
  rate: number;
  voiceURI: string | null;
}

export type TtsState = "idle" | "playing" | "paused";

const RATE_KEY = "tts.rate";
const VOICE_KEY = "tts.voiceURI";
export const DEFAULT_RATE = 1.2;

// Rough spoken-words-per-minute at rate 1.0. Used only for skip estimation.
const BASE_WPM = 150;

const MIN_RATE = 0.5;
const MAX_RATE = 3;

// --- formatting stripping -------------------------------------------------

/**
 * Remove markdown/formatting artifacts so the speech synth reads clean prose.
 * Handles headers, bold/italic, list markers, links, inline code, blockquotes.
 */
export function stripFormatting(text: string): string {
  let out = text;

  // Fenced code blocks: drop the fences, keep the inner text.
  out = out.replace(/```[a-zA-Z0-9]*\n?/g, "");

  // Links [text](url) -> text ; images ![alt](url) -> alt
  out = out.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");

  // Headers: strip leading # of any level.
  out = out.replace(/^[ \t]*#{1,6}[ \t]+/gm, "");

  // Blockquotes: strip leading >.
  out = out.replace(/^[ \t]*>[ \t]?/gm, "");

  // Unordered list markers at line start.
  out = out.replace(/^[ \t]*[-*+][ \t]+/gm, "");

  // Ordered list markers at line start (1. / 1) ).
  out = out.replace(/^[ \t]*\d+[.)][ \t]+/gm, "");

  // Bold/italic: **x**, __x__, *x*, _x_  -> x
  out = out.replace(/(\*\*|__)(.*?)\1/g, "$2");
  out = out.replace(/(\*|_)(.*?)\1/g, "$2");

  // Inline code `x` -> x
  out = out.replace(/`([^`]*)`/g, "$1");

  // Strip any remaining stray markdown punctuation that would be read aloud.
  out = out.replace(/[#*_`]/g, "");

  // Collapse runs of spaces/tabs but preserve newlines.
  out = out.replace(/[ \t]+/g, " ");
  // Trim each line.
  out = out
    .split("\n")
    .map((l) => l.trim())
    .join("\n");

  return out.trim();
}

// --- chunking -------------------------------------------------------------

/**
 * Split `text` into chunks no longer than `max` chars, breaking on sentence
 * boundaries where possible. A single sentence longer than `max` is split on
 * whitespace so no chunk exceeds the limit.
 */
export function chunkText(text: string, max = 200): string[] {
  const clean = text.trim();
  if (!clean) return [];

  // Split into sentences, keeping terminal punctuation.
  const sentences = clean.match(/[^.!?]+[.!?]+(?:["')\]]+)?|\S[^.!?]*$/g) ?? [clean];

  const chunks: string[] = [];
  let buffer = "";

  const flush = (): void => {
    const t = buffer.trim();
    if (t) chunks.push(t);
    buffer = "";
  };

  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;

    if (sentence.length > max) {
      // Over-long single sentence: flush buffer, then split on words.
      flush();
      let line = "";
      for (const word of sentence.split(/\s+/)) {
        if (word.length > max) {
          // Pathological single token longer than max: hard-split it.
          if (line.trim()) {
            chunks.push(line.trim());
            line = "";
          }
          for (let i = 0; i < word.length; i += max) {
            chunks.push(word.slice(i, i + max));
          }
          continue;
        }
        if ((line + " " + word).trim().length > max) {
          chunks.push(line.trim());
          line = word;
        } else {
          line = line ? `${line} ${word}` : word;
        }
      }
      if (line.trim()) chunks.push(line.trim());
      continue;
    }

    if ((buffer + " " + sentence).trim().length > max) {
      flush();
      buffer = sentence;
    } else {
      buffer = buffer ? `${buffer} ${sentence}` : sentence;
    }
  }
  flush();

  return chunks;
}

// --- prefs ----------------------------------------------------------------

function clampRate(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_RATE;
  return Math.min(MAX_RATE, Math.max(MIN_RATE, n));
}

export function loadPrefs(): TtsPrefs {
  let rate = DEFAULT_RATE;
  try {
    const stored = localStorage.getItem(RATE_KEY);
    if (stored !== null) {
      const parsed = Number(stored);
      rate = Number.isFinite(parsed) ? clampRate(parsed) : DEFAULT_RATE;
    }
  } catch {
    // localStorage unavailable (private mode etc.) — fall back to defaults.
  }
  let voiceURI: string | null = null;
  try {
    voiceURI = localStorage.getItem(VOICE_KEY);
  } catch {
    voiceURI = null;
  }
  return { rate, voiceURI };
}

export function savePrefs(prefs: Partial<TtsPrefs>): void {
  try {
    if (prefs.rate !== undefined) localStorage.setItem(RATE_KEY, String(clampRate(prefs.rate)));
    if (prefs.voiceURI !== undefined) {
      if (prefs.voiceURI === null) localStorage.removeItem(VOICE_KEY);
      else localStorage.setItem(VOICE_KEY, prefs.voiceURI);
    }
  } catch {
    // Best-effort; ignore storage failures.
  }
}

// --- skip math ------------------------------------------------------------

/** Number of words spoken in `seconds` at the given `rate`. */
export function wordsForSkip(rate: number, seconds: number): number {
  return Math.round((BASE_WPM * rate) / 60 * seconds);
}

// --- player ---------------------------------------------------------------

export interface TtsPlayerOptions {
  synth?: SpeechSynthesis;
  createUtterance?: (text: string) => SpeechSynthesisUtterance;
  onStateChange?: (state: TtsState, currentId: string | null) => void;
}

interface QueuedItem {
  id: string;
  words: string[]; // cleaned, word-tokenized text
  offset: number; // current word offset within the item
  chunks: string[]; // chunks for the remaining text from `offset`
  chunkIndex: number; // which chunk we are on
}

export class TtsPlayer {
  private readonly synth: SpeechSynthesis;
  private readonly createUtterance: (text: string) => SpeechSynthesisUtterance;
  private readonly onStateChange?: (state: TtsState, currentId: string | null) => void;

  private queue: QueuedItem[] = [];
  private index = 0;
  private state: TtsState = "idle";
  private rate: number;
  private voiceURI: string | null;
  // Monotonic token incremented on every cancel()/stop()/skip()/play(). An
  // utterance's onend/onerror only acts if its captured token still matches —
  // this discards the spurious onend that browsers fire for a cancelled
  // utterance, preventing a double-advance of the queue.
  private generation = 0;

  constructor(opts: TtsPlayerOptions = {}) {
    this.synth = opts.synth ?? (globalThis as unknown as { speechSynthesis: SpeechSynthesis }).speechSynthesis;
    this.createUtterance =
      opts.createUtterance ??
      ((text: string) =>
        new (globalThis as unknown as {
          SpeechSynthesisUtterance: new (t: string) => SpeechSynthesisUtterance;
        }).SpeechSynthesisUtterance(text));
    this.onStateChange = opts.onStateChange;

    const prefs = loadPrefs();
    this.rate = prefs.rate;
    this.voiceURI = prefs.voiceURI;

    // iOS suspends synthesis when the tab backgrounds; resume on return.
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", this.handleVisibility);
    }
  }

  private handleVisibility = (): void => {
    if (typeof document === "undefined") return;
    if (document.visibilityState === "visible" && this.state === "playing") {
      // Nudge the engine: iOS leaves it paused after backgrounding.
      try {
        this.synth.resume();
      } catch {
        // ignore
      }
    }
  };

  setRate(rate: number): void {
    this.rate = clampRate(rate);
    savePrefs({ rate: this.rate });
  }

  getRate(): number {
    return this.rate;
  }

  setVoiceURI(uri: string | null): void {
    this.voiceURI = uri;
    savePrefs({ voiceURI: uri });
  }

  getVoiceURI(): string | null {
    return this.voiceURI;
  }

  isPlaying(): boolean {
    return this.state === "playing";
  }

  getState(): TtsState {
    return this.state;
  }

  currentId(): string | null {
    return this.queue[this.index]?.id ?? null;
  }

  /** Build the queue and start speaking the first chunk. Must be called from a
   *  user gesture (we never auto-speak). */
  play(items: readonly TtsItem[]): void {
    this.cancel();
    this.queue = items
      .map((it) => this.buildItem(it.id, it.text, 0))
      .filter((q) => q.chunks.length > 0);
    this.index = 0;
    if (this.queue.length === 0) {
      this.setState("idle");
      return;
    }
    this.setState("playing");
    this.speakCurrentChunk();
  }

  pause(): void {
    if (this.state !== "playing") return;
    try {
      this.synth.pause();
    } catch {
      // ignore
    }
    this.setState("paused");
  }

  resume(): void {
    if (this.state !== "paused") return;
    try {
      this.synth.resume();
    } catch {
      // ignore
    }
    this.setState("playing");
  }

  stop(): void {
    this.cancel();
    this.queue = [];
    this.index = 0;
    this.setState("idle");
  }

  /** Skip forward `seconds` within the current item. */
  skip(seconds = 30): void {
    const item = this.queue[this.index];
    if (!item) return;
    const advance = wordsForSkip(this.rate, seconds);
    const newOffset = item.offset + advance;
    if (newOffset >= item.words.length) {
      // Past the end of this item — move to the next.
      this.advanceItem();
      return;
    }
    const rebuilt = this.buildItem(item.id, item.words.join(" "), newOffset);
    this.queue[this.index] = rebuilt;
    this.cancel();
    if (this.state !== "paused") this.setState("playing");
    this.speakCurrentChunk();
  }

  /** Tear down listeners. */
  dispose(): void {
    this.stop();
    if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
      document.removeEventListener("visibilitychange", this.handleVisibility);
    }
  }

  // --- internals ----------------------------------------------------------

  private buildItem(id: string, rawText: string, offset: number): QueuedItem {
    const clean = stripFormatting(rawText);
    const words = clean.split(/\s+/).filter(Boolean);
    const remaining = words.slice(offset).join(" ");
    return {
      id,
      words,
      offset,
      chunks: chunkText(remaining, 200),
      chunkIndex: 0,
    };
  }

  private cancel(): void {
    // Invalidate any in-flight utterance callbacks before cancelling.
    this.generation += 1;
    try {
      this.synth.cancel();
    } catch {
      // ignore
    }
  }

  private setState(state: TtsState): void {
    this.state = state;
    this.onStateChange?.(state, this.currentId());
  }

  private speakCurrentChunk(): void {
    const item = this.queue[this.index];
    if (!item) {
      this.setState("idle");
      return;
    }
    const chunk = item.chunks[item.chunkIndex];
    if (chunk === undefined) {
      this.advanceItem();
      return;
    }
    const u = this.createUtterance(chunk);
    u.rate = this.rate;
    if (this.voiceURI) {
      const voice = this.findVoice(this.voiceURI);
      if (voice) u.voice = voice;
    }
    const gen = this.generation;
    u.onend = () => this.handleChunkEnd(gen);
    u.onerror = () => this.handleChunkEnd(gen);
    this.synth.speak(u);
  }

  private findVoice(uri: string): SpeechSynthesisVoice | null {
    try {
      return this.synth.getVoices().find((v) => v.voiceURI === uri || v.name === uri) ?? null;
    } catch {
      return null;
    }
  }

  private handleChunkEnd(gen: number): void {
    if (gen !== this.generation) return; // stale callback from a cancelled utterance
    if (this.state === "idle") return; // stopped
    const item = this.queue[this.index];
    if (!item) {
      this.setState("idle");
      return;
    }
    item.chunkIndex += 1;
    if (item.chunkIndex < item.chunks.length) {
      this.speakCurrentChunk();
    } else {
      this.advanceItem();
    }
  }

  private advanceItem(): void {
    this.index += 1;
    if (this.index >= this.queue.length) {
      this.queue = [];
      this.index = 0;
      this.setState("idle");
      return;
    }
    this.speakCurrentChunk();
  }
}
