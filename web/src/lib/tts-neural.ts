// Neural HTTP TtsBackend for digest playback (#63).
//
// Talks to a self-hosted Kokoro-FastAPI instance over its OpenAI-compatible
// speech API:
//   POST /v1/audio/speech  { model, input, voice, response_format, speed } -> mp3 bytes
//   GET  /v1/audio/voices  -> { voices: [{ id, name }] }
//
// Responsibilities:
//   - Synthesize one chunk per request, play via HTMLAudioElement.
//   - In-memory cache keyed `${voice}|${rate}|hash(text)` -> object URL so a
//     replay within the session skips the round-trip (soft cap, evict oldest).
//   - Real seek within the current chunk via `currentTime`.
//   - A speak() superseded by cancel() must never start playing late (session
//     token guards the async fetch).
//   - Fetch/decoding failure -> call onEnd so the player advances instead of
//     wedging; never throw out of speak().

import type { TtsBackend, TtsVoice } from "./tts";

export const DEFAULT_NEURAL_VOICE = "af_heart";

const MAX_CACHE_ENTRIES = 64;
const NEURAL_MAX_CHUNK_CHARS = 4000;

export interface NeuralHttpBackendOptions {
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to `new Audio(src)`. */
  audioFactory?: (src: string) => HTMLAudioElement;
  /** Cache size cap; defaults to 64. */
  maxCacheEntries?: number;
}

/** Tiny non-cryptographic string hash (djb2) for cache keys. */
function hashText(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

export class NeuralHttpBackend implements TtsBackend {
  readonly supportsRealSeek = true;
  readonly maxChunkChars = NEURAL_MAX_CHUNK_CHARS;

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly audioFactory: (src: string) => HTMLAudioElement;
  private readonly maxCacheEntries: number;

  // key -> object URL. Map preserves insertion order, so the first key is the
  // oldest entry when we need to evict.
  private readonly cache = new Map<string, string>();
  private current: HTMLAudioElement | null = null;
  // Monotonic token: cancel() bumps it, so an in-flight speak() whose token no
  // longer matches must not start playback or report an end.
  private session = 0;

  constructor(baseUrl: string, opts: NeuralHttpBackendOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
    this.audioFactory =
      opts.audioFactory ??
      ((src: string) =>
        new (globalThis as unknown as { Audio: new (s: string) => HTMLAudioElement }).Audio(src));
    this.maxCacheEntries = opts.maxCacheEntries ?? MAX_CACHE_ENTRIES;
  }

  speak(
    text: string,
    opts: { rate: number; voiceURI: string | null },
    onEnd: () => void,
  ): void {
    this.cancel();
    const session = this.session;
    const voice = opts.voiceURI || DEFAULT_NEURAL_VOICE;

    void this.getAudioUrl(text, voice, opts.rate)
      .then((url) => {
        if (session !== this.session) return; // superseded while fetching
        const audio = this.audioFactory(url);
        const finish = (): void => {
          if (session !== this.session) return;
          this.current = null;
          onEnd();
        };
        audio.onended = finish;
        audio.onerror = finish;
        this.current = audio;
        const p = audio.play();
        // play() returns a promise in browsers; a rejection (autoplay policy,
        // decode failure) must advance the queue, not wedge it.
        if (p && typeof p.catch === "function") {
          p.catch(() => {
            if (session !== this.session) return;
            this.current = null;
            onEnd();
          });
        }
      })
      .catch(() => {
        // Synthesis failed (network/server). Report the end so the player
        // moves on; it will go idle if every chunk fails.
        if (session !== this.session) return;
        onEnd();
      });
  }

  pause(): void {
    try {
      this.current?.pause();
    } catch {
      // ignore
    }
  }

  resume(): void {
    const p = this.current?.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
  }

  cancel(): void {
    this.session += 1;
    const audio = this.current;
    this.current = null;
    if (!audio) return;
    audio.onended = null;
    audio.onerror = null;
    try {
      audio.pause();
    } catch {
      // ignore
    }
  }

  /**
   * Seek within the playing chunk by bumping `currentTime`.
   * Returns false (caller should advance) when there is no current audio or
   * the target is at/past the end of the chunk.
   */
  seekWithinCurrent(seconds: number): boolean {
    const audio = this.current;
    if (!audio) return false;
    const target = audio.currentTime + seconds;
    if (Number.isFinite(audio.duration) && target >= audio.duration) return false;
    audio.currentTime = Math.max(0, target);
    return true;
  }

  async listVoices(): Promise<TtsVoice[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/audio/voices`);
    if (!res.ok) throw new Error(`voices endpoint returned ${res.status}`);
    const data = (await res.json()) as { voices?: unknown[] };
    const voices = Array.isArray(data.voices) ? data.voices : [];
    return voices.map((v) => {
      // Locked contract is [{id, name}]; tolerate bare string ids too.
      if (typeof v === "string") return { id: v, label: v };
      const o = v as { id: string; name?: string };
      return { id: o.id, label: o.name ?? o.id };
    });
  }

  // --- internals ------------------------------------------------------------

  private async getAudioUrl(text: string, voice: string, rate: number): Promise<string> {
    const key = `${voice}|${rate}|${hashText(text)}`;
    const cached = this.cache.get(key);
    if (cached) {
      // Refresh recency so hot entries survive eviction.
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }

    const res = await this.fetchImpl(`${this.baseUrl}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "kokoro",
        input: text,
        voice,
        response_format: "mp3",
        speed: rate,
      }),
    });
    if (!res.ok) throw new Error(`speech endpoint returned ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);

    this.cache.set(key, url);
    if (this.cache.size > this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value as string;
      const evicted = this.cache.get(oldest);
      this.cache.delete(oldest);
      if (evicted) URL.revokeObjectURL(evicted);
    }
    return url;
  }
}
