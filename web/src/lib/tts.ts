// Web Speech API text-to-speech wrapper for digest playback (#11).
// Extended in #63 to support a pluggable TtsBackend interface so neural HTTP
// backends (Kokoro-FastAPI) can be swapped in while Web Speech remains the
// zero-dependency fallback.
//
// Responsibilities:
//   - Strip markdown/formatting artifacts so the synth never reads "asterisk" etc.
//   - Chunk text on sentence boundaries (max chars from backend) to dodge the iOS
//     Safari long-utterance cutoff and to keep HTTP round-trips sane.
//   - Maintain a playlist queue; `onend` advances to the next chunk, then the
//     next item.
//   - Persist voice + rate in localStorage (default rate 1.2).
//   - skip-30s: prefers backend.seekWithinCurrent when available (neural), falls
//     back to word-estimate rebuild for Web Speech.
//   - iOS: never auto-speak; resume on `visibilitychange`.

export interface TtsItem {
  id: string;
  text: string;
}

export interface TtsPrefs {
  rate: number;
  voiceURI: string | null;
}

export type TtsState = "idle" | "playing" | "paused";

// --- backend abstraction ---------------------------------------------------

/** A voice entry returned by a backend's listVoices(). */
export interface TtsVoice {
  id: string;
  label: string;
}

/**
 * Pluggable TTS engine.  TtsPlayer drives one of these; callers who need
 * neural or Web Speech behaviour only differ via the backend they pass.
 */
export interface TtsBackend {
  /** True when the backend supports real-time seek via seekWithinCurrent(). */
  supportsRealSeek: boolean;
  /**
   * Maximum characters per chunk this backend handles well.
   * Web Speech: ~200 (iOS long-utterance cutoff).
   * Neural HTTP: ~4000 (a single HTTP request, no utterance limit).
   */
  maxChunkChars: number;

  /**
   * Start speaking `text` at `rate` using `voiceURI`.
   * Call `onEnd` when the chunk finishes (or on error).
   */
  speak(
    text: string,
    opts: { rate: number; voiceURI: string | null },
    onEnd: () => void,
  ): void;

  pause(): void;
  resume(): void;
  cancel(): void;

  /**
   * Seek forward/back within the currently-playing chunk by `seconds`.
   * Return false when the seek position is past the end (caller should advance).
   * Optional — backends that don't support real seek omit this method.
   */
  seekWithinCurrent?(seconds: number): boolean;

  /** Return the voices this backend can use, for populating the UI. */
  listVoices(): TtsVoice[] | Promise<TtsVoice[]>;
}

// --- WebSpeechBackend ------------------------------------------------------

/** Web Speech implementation of TtsBackend. Default + fallback. */
export class WebSpeechBackend implements TtsBackend {
  readonly supportsRealSeek = false;
  readonly maxChunkChars = 200;

  private readonly synth: SpeechSynthesis;
  private readonly createUtterance: (text: string) => SpeechSynthesisUtterance;

  constructor(
    synth: SpeechSynthesis,
    createUtterance: (text: string) => SpeechSynthesisUtterance,
  ) {
    this.synth = synth;
    this.createUtterance = createUtterance;
  }

  speak(
    text: string,
    opts: { rate: number; voiceURI: string | null },
    onEnd: () => void,
  ): void {
    const u = this.createUtterance(text);
    u.rate = opts.rate;
    if (opts.voiceURI) {
      const voice = this.findVoice(opts.voiceURI);
      if (voice) u.voice = voice;
    }
    u.onend = onEnd;
    u.onerror = onEnd;
    this.synth.speak(u);
  }

  pause(): void {
    try {
      this.synth.pause();
    } catch {
      // ignore
    }
  }

  resume(): void {
    try {
      this.synth.resume();
    } catch {
      // ignore
    }
  }

  cancel(): void {
    try {
      this.synth.cancel();
    } catch {
      // ignore
    }
  }

  listVoices(): TtsVoice[] {
    try {
      return this.synth.getVoices().map((v) => ({ id: v.voiceURI, label: v.name }));
    } catch {
      return [];
    }
  }

  private findVoice(uri: string): SpeechSynthesisVoice | null {
    try {
      return this.synth.getVoices().find((v) => v.voiceURI === uri || v.name === uri) ?? null;
    } catch {
      return null;
    }
  }
}

// --- createDefaultBackend ----------------------------------------------------

export interface CreateBackendOptions {
  /** Override the endpoint; defaults to import.meta.env.VITE_TTS_NEURAL_URL. */
  neuralUrl?: string;
  /** Injectable for tests; passed through to NeuralHttpBackend. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; passed through to NeuralHttpBackend. */
  audioFactory?: (src: string) => HTMLAudioElement;
}

/**
 * Build the right backend for this environment.
 * If VITE_TTS_NEURAL_URL is set AND the endpoint answers the reachability
 * probe (GET /v1/audio/voices), use the neural backend; otherwise fall back
 * to Web Speech. URL absent by default → Web Speech, zero dependencies.
 */
export async function createDefaultBackend(opts: CreateBackendOptions = {}): Promise<TtsBackend> {
  const neuralUrl = opts.neuralUrl ?? import.meta.env.VITE_TTS_NEURAL_URL;
  if (neuralUrl) {
    try {
      // Dynamic import keeps the neural code out of the bundle's hot path.
      const { NeuralHttpBackend } = await import("./tts-neural");
      const backend = new NeuralHttpBackend(neuralUrl, {
        fetchImpl: opts.fetchImpl,
        audioFactory: opts.audioFactory,
      });
      // Probe: listVoices rejects when the endpoint is unreachable.
      await backend.listVoices();
      return backend;
    } catch {
      // Neural endpoint unreachable — fall through to Web Speech.
    }
  }
  const g = globalThis as unknown as {
    speechSynthesis: SpeechSynthesis;
    SpeechSynthesisUtterance: new (text: string) => SpeechSynthesisUtterance;
  };
  return new WebSpeechBackend(g.speechSynthesis, (text) => new g.SpeechSynthesisUtterance(text));
}

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
  /** Legacy: inject a Web Speech synth (used by tests). */
  synth?: SpeechSynthesis;
  /** Legacy: inject utterance factory (used by tests). */
  createUtterance?: (text: string) => SpeechSynthesisUtterance;
  /** New: provide a fully-constructed backend. Takes precedence over synth/createUtterance. */
  backend?: TtsBackend;
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
  private readonly backend: TtsBackend;
  private readonly onStateChange?: (state: TtsState, currentId: string | null) => void;

  private queue: QueuedItem[] = [];
  private index = 0;
  private state: TtsState = "idle";
  private rate: number;
  private voiceURI: string | null;
  // Monotonic token incremented on every cancel()/stop()/skip()/play(). An
  // onEnd callback only acts if its captured token still matches — discards
  // the spurious callback that browsers fire for a cancelled utterance,
  // preventing a double-advance of the queue.
  private generation = 0;

  constructor(opts: TtsPlayerOptions = {}) {
    if (opts.backend) {
      this.backend = opts.backend;
    } else {
      // Legacy path: wrap synth + createUtterance into a WebSpeechBackend so
      // existing tests pass without modification.
      const synth =
        opts.synth ??
        (globalThis as unknown as { speechSynthesis: SpeechSynthesis }).speechSynthesis;
      const createUtterance =
        opts.createUtterance ??
        ((text: string) =>
          new (
            globalThis as unknown as {
              SpeechSynthesisUtterance: new (t: string) => SpeechSynthesisUtterance;
            }
          ).SpeechSynthesisUtterance(text));
      this.backend = new WebSpeechBackend(synth, createUtterance);
    }
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
      this.backend.resume();
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

  /** Return voices from the active backend (for populating the settings UI). */
  listVoices(): TtsVoice[] | Promise<TtsVoice[]> {
    return this.backend.listVoices();
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
    this.backend.pause();
    this.setState("paused");
  }

  resume(): void {
    if (this.state !== "paused") return;
    this.backend.resume();
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

    // If the backend supports real seek, try it first.
    if (this.backend.seekWithinCurrent) {
      const stayed = this.backend.seekWithinCurrent(seconds);
      if (stayed) return; // backend handled it in-place
      // seekWithinCurrent returned false → past end of current chunk; advance.
      this.advanceItem();
      return;
    }

    // Web Speech fallback: rebuild from the estimated word offset.
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
      chunks: chunkText(remaining, this.backend.maxChunkChars),
      chunkIndex: 0,
    };
  }

  private cancel(): void {
    // Invalidate any in-flight callbacks before cancelling.
    this.generation += 1;
    this.backend.cancel();
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
    const gen = this.generation;
    this.backend.speak(
      chunk,
      { rate: this.rate, voiceURI: this.voiceURI },
      () => this.handleChunkEnd(gen),
    );
  }

  private handleChunkEnd(gen: number): void {
    if (gen !== this.generation) return; // stale callback from a cancelled chunk
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
