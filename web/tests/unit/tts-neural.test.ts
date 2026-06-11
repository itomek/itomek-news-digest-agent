// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NeuralHttpBackend } from "../../src/lib/tts-neural";
import { createDefaultBackend, WebSpeechBackend } from "../../src/lib/tts";

// --- fakes -------------------------------------------------------------------

/** Minimal HTMLAudioElement stand-in: records calls, lets tests fire events. */
class FakeAudio {
  src: string;
  currentTime = 0;
  duration = NaN;
  paused = true;
  playCalls = 0;
  pauseCalls = 0;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(src: string) {
    this.src = src;
  }
  play(): Promise<void> {
    this.playCalls += 1;
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.pauseCalls += 1;
    this.paused = true;
  }
}

interface FetchCall {
  url: string;
  init?: RequestInit;
}

/** fetch stub returning fake mp3 bytes for speech and a voice list for voices. */
function makeFetch(opts: { failSpeech?: boolean; failVoices?: boolean } = {}) {
  const calls: FetchCall[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.endsWith("/v1/audio/voices")) {
      if (opts.failVoices) throw new Error("connection refused");
      return {
        ok: true,
        json: async () => ({
          voices: [
            { id: "en-US-Chirp3-HD-Aoede", name: "Aoede" },
            { id: "en-US-Chirp3-HD-Puck", name: "Puck" },
          ],
        }),
      } as unknown as Response;
    }
    if (opts.failSpeech) throw new Error("connection refused");
    return {
      ok: true,
      blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mpeg" }),
    } as unknown as Response;
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function makeBackend(
  fetchImpl: typeof fetch,
  audios: FakeAudio[],
  cacheCap?: number,
): NeuralHttpBackend {
  return new NeuralHttpBackend("http://tts.local:8880", {
    fetchImpl,
    audioFactory: (src: string) => {
      const a = new FakeAudio(src);
      audios.push(a);
      return a as unknown as HTMLAudioElement;
    },
    maxCacheEntries: cacheCap,
  });
}

/** Flush pending microtasks/timers so speak()'s fetch chain settles. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

let urlCounter = 0;

beforeEach(() => {
  localStorage.clear();
  urlCounter = 0;
  // jsdom lacks createObjectURL; the backend turns blobs into object URLs.
  Object.defineProperty(URL, "createObjectURL", {
    value: vi.fn(() => `blob:fake-${urlCounter++}`),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    value: vi.fn(),
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- speak: request contract ---------------------------------------------------

describe("NeuralHttpBackend.speak", () => {
  it("POSTs the locked OpenAI-compatible body to /v1/audio/speech", async () => {
    const { fetchImpl, calls } = makeFetch();
    const audios: FakeAudio[] = [];
    const backend = makeBackend(fetchImpl, audios);

    backend.speak("Hello world.", { rate: 1.5, voiceURI: "en-US-Chirp3-HD-Puck" }, () => {});
    await flush();

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("http://tts.local:8880/v1/audio/speech");
    expect(calls[0].init?.method).toBe("POST");
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body).toEqual({
      model: "tts-1",
      input: "Hello world.",
      voice: "en-US-Chirp3-HD-Puck",
      response_format: "mp3",
      speed: 1.5,
    });
  });

  it("sends an empty voice when voiceURI is null so the server default applies", async () => {
    const { fetchImpl, calls } = makeFetch();
    const backend = makeBackend(fetchImpl, []);
    backend.speak("Hi.", { rate: 1, voiceURI: null }, () => {});
    await flush();
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.voice).toBe("");
  });

  it("turns the response blob into an object URL and plays it", async () => {
    const { fetchImpl } = makeFetch();
    const audios: FakeAudio[] = [];
    const backend = makeBackend(fetchImpl, audios);
    backend.speak("Hi.", { rate: 1, voiceURI: null }, () => {});
    await flush();
    expect(audios.length).toBe(1);
    expect(audios[0].src).toMatch(/^blob:fake-/);
    expect(audios[0].playCalls).toBe(1);
  });

  it("fires onEnd when the audio element ends", async () => {
    const { fetchImpl } = makeFetch();
    const audios: FakeAudio[] = [];
    const backend = makeBackend(fetchImpl, audios);
    let ended = 0;
    backend.speak("Hi.", { rate: 1, voiceURI: null }, () => {
      ended += 1;
    });
    await flush();
    audios[0].onended?.();
    expect(ended).toBe(1);
  });

  it("fires onEnd (graceful, no crash) when fetch rejects", async () => {
    const { fetchImpl } = makeFetch({ failSpeech: true });
    const backend = makeBackend(fetchImpl, []);
    let ended = 0;
    backend.speak("Hi.", { rate: 1, voiceURI: null }, () => {
      ended += 1;
    });
    await flush();
    expect(ended).toBe(1);
  });

  it("does not play or call onEnd when cancelled before the fetch resolves", async () => {
    const { fetchImpl } = makeFetch();
    const audios: FakeAudio[] = [];
    const backend = makeBackend(fetchImpl, audios);
    let ended = 0;
    backend.speak("Hi.", { rate: 1, voiceURI: null }, () => {
      ended += 1;
    });
    backend.cancel(); // before flush — fetch still in flight
    await flush();
    expect(audios.length).toBe(0);
    expect(ended).toBe(0);
  });
});

// --- caching -------------------------------------------------------------------

describe("NeuralHttpBackend cache", () => {
  it("serves a repeat of the same voice|rate|text from cache (no 2nd fetch)", async () => {
    const { fetchImpl, calls } = makeFetch();
    const audios: FakeAudio[] = [];
    const backend = makeBackend(fetchImpl, audios);

    backend.speak("Same text.", { rate: 1.2, voiceURI: "en-US-Chirp3-HD-Aoede" }, () => {});
    await flush();
    backend.speak("Same text.", { rate: 1.2, voiceURI: "en-US-Chirp3-HD-Aoede" }, () => {});
    await flush();

    const speechCalls = calls.filter((c) => c.url.endsWith("/v1/audio/speech"));
    expect(speechCalls.length).toBe(1);
    expect(audios.length).toBe(2); // played twice, fetched once
  });

  it("misses the cache when rate or voice differs", async () => {
    const { fetchImpl, calls } = makeFetch();
    const backend = makeBackend(fetchImpl, []);
    backend.speak("Same text.", { rate: 1.2, voiceURI: "en-US-Chirp3-HD-Aoede" }, () => {});
    await flush();
    backend.speak("Same text.", { rate: 1.5, voiceURI: "en-US-Chirp3-HD-Aoede" }, () => {});
    await flush();
    backend.speak("Same text.", { rate: 1.2, voiceURI: "en-US-Chirp3-HD-Puck" }, () => {});
    await flush();
    const speechCalls = calls.filter((c) => c.url.endsWith("/v1/audio/speech"));
    expect(speechCalls.length).toBe(3);
  });

  it("evicts the oldest entry (and revokes its URL) past the cap", async () => {
    const { fetchImpl, calls } = makeFetch();
    const backend = makeBackend(fetchImpl, [], 2); // tiny cap for the test

    backend.speak("One.", { rate: 1, voiceURI: null }, () => {});
    await flush();
    backend.speak("Two.", { rate: 1, voiceURI: null }, () => {});
    await flush();
    backend.speak("Three.", { rate: 1, voiceURI: null }, () => {});
    await flush();
    // "One." should have been evicted — speaking it again re-fetches.
    backend.speak("One.", { rate: 1, voiceURI: null }, () => {});
    await flush();

    const speechCalls = calls.filter((c) => c.url.endsWith("/v1/audio/speech"));
    expect(speechCalls.length).toBe(4);
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });
});

// --- transport controls ---------------------------------------------------------

describe("NeuralHttpBackend transport", () => {
  async function playing(): Promise<{ backend: NeuralHttpBackend; audio: FakeAudio }> {
    const { fetchImpl } = makeFetch();
    const audios: FakeAudio[] = [];
    const backend = makeBackend(fetchImpl, audios);
    backend.speak("Hello.", { rate: 1, voiceURI: null }, () => {});
    await flush();
    return { backend, audio: audios[0] };
  }

  it("pause/resume drive the audio element", async () => {
    const { backend, audio } = await playing();
    backend.pause();
    expect(audio.pauseCalls).toBe(1);
    backend.resume();
    expect(audio.playCalls).toBe(2);
  });

  it("cancel pauses and detaches the current audio", async () => {
    const { backend, audio } = await playing();
    let endedAfterCancel = 0;
    audio.onended = () => {
      endedAfterCancel += 1;
    };
    backend.cancel();
    expect(audio.pauseCalls).toBe(1);
    // Handlers detached: a late ended event must not fire through.
    expect(audio.onended).toBeNull();
    expect(endedAfterCancel).toBe(0);
  });

  it("seekWithinCurrent bumps currentTime and returns true within bounds", async () => {
    const { backend, audio } = await playing();
    audio.duration = 100;
    audio.currentTime = 10;
    expect(backend.seekWithinCurrent(30)).toBe(true);
    expect(audio.currentTime).toBe(40);
  });

  it("seekWithinCurrent returns false past the end so the player advances", async () => {
    const { backend, audio } = await playing();
    audio.duration = 20;
    audio.currentTime = 10;
    expect(backend.seekWithinCurrent(30)).toBe(false);
  });

  it("seekWithinCurrent returns false with no current audio", () => {
    const { fetchImpl } = makeFetch();
    const backend = makeBackend(fetchImpl, []);
    expect(backend.seekWithinCurrent(30)).toBe(false);
  });

  it("advertises real seek and small chunks for low-latency first audio", () => {
    const { fetchImpl } = makeFetch();
    const backend = makeBackend(fetchImpl, []);
    expect(backend.supportsRealSeek).toBe(true);
    // Fix #1: ~700 chars so first audio arrives in ~1–2s, not 4000 chars (~10s).
    expect(backend.maxChunkChars).toBeGreaterThanOrEqual(600);
    expect(backend.maxChunkChars).toBeLessThanOrEqual(800);
  });
});

// --- listVoices ------------------------------------------------------------------

describe("NeuralHttpBackend.listVoices", () => {
  it("GETs /v1/audio/voices and maps {id, name} to {id, label}", async () => {
    const { fetchImpl, calls } = makeFetch();
    const backend = makeBackend(fetchImpl, []);
    const voices = await backend.listVoices();
    expect(calls[0].url).toBe("http://tts.local:8880/v1/audio/voices");
    expect(voices).toEqual([
      { id: "en-US-Chirp3-HD-Aoede", label: "Aoede" },
      { id: "en-US-Chirp3-HD-Puck", label: "Puck" },
    ]);
  });

  it("handles a bare string voice list defensively", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ voices: ["en-US-Chirp3-HD-Aoede", "en-US-Chirp3-HD-Puck"] }),
    })) as unknown as typeof fetch;
    const backend = new NeuralHttpBackend("http://tts.local:8880", { fetchImpl });
    const voices = await backend.listVoices();
    expect(voices).toEqual([
      { id: "en-US-Chirp3-HD-Aoede", label: "en-US-Chirp3-HD-Aoede" },
      { id: "en-US-Chirp3-HD-Puck", label: "en-US-Chirp3-HD-Puck" },
    ]);
  });

  it("rejects when the endpoint is unreachable (probe contract)", async () => {
    const { fetchImpl } = makeFetch({ failVoices: true });
    const backend = makeBackend(fetchImpl, []);
    await expect(backend.listVoices()).rejects.toThrow();
  });
});

// --- createDefaultBackend ----------------------------------------------------------

describe("createDefaultBackend", () => {
  function installSpeechStubs(): void {
    Object.defineProperty(globalThis, "speechSynthesis", {
      value: { getVoices: () => [], speak() {}, pause() {}, resume() {}, cancel() {} },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
      value: class {
        text: string;
        constructor(t: string) {
          this.text = t;
        }
      },
      configurable: true,
      writable: true,
    });
  }

  it("returns NeuralHttpBackend when a URL is set and the probe succeeds", async () => {
    installSpeechStubs();
    const { fetchImpl } = makeFetch();
    const backend = await createDefaultBackend({
      neuralUrl: "http://tts.local:8880",
      fetchImpl,
    });
    expect(backend).toBeInstanceOf(NeuralHttpBackend);
  });

  it("falls back to WebSpeechBackend when the probe fails", async () => {
    installSpeechStubs();
    const { fetchImpl } = makeFetch({ failVoices: true });
    const backend = await createDefaultBackend({
      neuralUrl: "http://tts.local:8880",
      fetchImpl,
    });
    expect(backend).toBeInstanceOf(WebSpeechBackend);
  });

  it("returns WebSpeechBackend when no URL is configured", async () => {
    installSpeechStubs();
    const backend = await createDefaultBackend({ neuralUrl: "" });
    expect(backend).toBeInstanceOf(WebSpeechBackend);
  });

  it("passes the headers provider through to the probe request", async () => {
    installSpeechStubs();
    const { fetchImpl, calls } = makeFetch();
    await createDefaultBackend({
      neuralUrl: "http://tts.local:8880",
      fetchImpl,
      headers: () => ({ Authorization: "Bearer probe-token" }),
    });
    const probe = calls.find((c) => c.url.endsWith("/v1/audio/voices"));
    expect(probe).toBeTruthy();
    expect((probe!.init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer probe-token",
    );
  });
});

// --- auth headers ------------------------------------------------------------------

describe("NeuralHttpBackend headers provider", () => {
  function authedBackend(fetchImpl: typeof fetch, audios: FakeAudio[]) {
    return new NeuralHttpBackend("http://tts.local:8880", {
      fetchImpl,
      audioFactory: (src: string) => {
        const a = new FakeAudio(src);
        audios.push(a);
        return a as unknown as HTMLAudioElement;
      },
      headers: () => ({ Authorization: "Bearer test-token", apikey: "anon-key" }),
    });
  }

  it("attaches headers to the speech POST", async () => {
    const { fetchImpl, calls } = makeFetch();
    const backend = authedBackend(fetchImpl, []);
    backend.speak("Hi.", { rate: 1, voiceURI: null }, () => {});
    await flush();
    const speech = calls.find((c) => c.url.endsWith("/v1/audio/speech"))!;
    const headers = speech.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
    expect(headers.apikey).toBe("anon-key");
    // Content type is still set alongside the auth headers.
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("attaches headers to listVoices", async () => {
    const { fetchImpl, calls } = makeFetch();
    const backend = authedBackend(fetchImpl, []);
    await backend.listVoices();
    const voices = calls.find((c) => c.url.endsWith("/v1/audio/voices"))!;
    expect((voices.init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-token",
    );
  });

  it("supports an async headers provider", async () => {
    const { fetchImpl, calls } = makeFetch();
    const backend = new NeuralHttpBackend("http://tts.local:8880", {
      fetchImpl,
      headers: async () => ({ Authorization: "Bearer async-token" }),
    });
    await backend.listVoices();
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer async-token",
    );
  });

  it("speaks fine (no headers) when the provider is omitted", async () => {
    const { fetchImpl, calls } = makeFetch();
    const audios: FakeAudio[] = [];
    const backend = makeBackend(fetchImpl, audios);
    backend.speak("Hi.", { rate: 1, voiceURI: null }, () => {});
    await flush();
    expect(audios.length).toBe(1);
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("still ends gracefully when the headers provider throws", async () => {
    const { fetchImpl } = makeFetch();
    const backend = new NeuralHttpBackend("http://tts.local:8880", {
      fetchImpl,
      headers: () => {
        throw new Error("no session");
      },
    });
    let ended = 0;
    backend.speak("Hi.", { rate: 1, voiceURI: null }, () => {
      ended += 1;
    });
    await flush();
    expect(ended).toBe(1);
  });
});

// --- prefetch (Fix #2) ----------------------------------------------------------------

describe("NeuralHttpBackend.prefetch", () => {
  it("warms the cache so a subsequent speak causes no new fetch", async () => {
    const { fetchImpl, calls } = makeFetch();
    const audios: FakeAudio[] = [];
    const backend = makeBackend(fetchImpl, audios);

    // prefetch the text without playing it
    await backend.prefetch("Prefetched text.", { rate: 1.2, voiceURI: "en-US-Chirp3-HD-Aoede" });

    const callsAfterPrefetch = calls.filter((c) => c.url.endsWith("/v1/audio/speech")).length;
    expect(callsAfterPrefetch).toBe(1); // one fetch to warm cache

    // speak the same text — must use cache, no new request
    backend.speak("Prefetched text.", { rate: 1.2, voiceURI: "en-US-Chirp3-HD-Aoede" }, () => {});
    await flush();

    const callsAfterSpeak = calls.filter((c) => c.url.endsWith("/v1/audio/speech")).length;
    expect(callsAfterSpeak).toBe(1); // still 1 — cache was hit
    expect(audios.length).toBe(1); // audio was created and played
  });

  it("prefetch failure is swallowed (never rejects)", async () => {
    const { fetchImpl } = makeFetch({ failSpeech: true });
    const backend = makeBackend(fetchImpl, []);
    // Must not throw or reject
    await expect(
      backend.prefetch("Some text.", { rate: 1, voiceURI: null }),
    ).resolves.toBeUndefined();
  });

  it("prefetch does not start audio playback", async () => {
    const { fetchImpl } = makeFetch();
    const audios: FakeAudio[] = [];
    const backend = makeBackend(fetchImpl, audios);
    await backend.prefetch("No play.", { rate: 1, voiceURI: null });
    expect(audios.length).toBe(0); // no audio element created
  });

  it("prefetch does not disturb current session (ongoing speak is unaffected)", async () => {
    const { fetchImpl } = makeFetch();
    const audios: FakeAudio[] = [];
    const backend = makeBackend(fetchImpl, audios);

    let ended = 0;
    backend.speak("Current chunk.", { rate: 1, voiceURI: null }, () => { ended += 1; });
    await flush();
    const currentAudio = audios[0];

    // prefetch a different chunk while audio is playing
    await backend.prefetch("Next chunk.", { rate: 1, voiceURI: null });

    // current audio still active; simulating end fires our onEnd
    currentAudio.onended?.();
    expect(ended).toBe(1);
    expect(audios.length).toBe(1); // prefetch created no audio
  });
});

// --- getProgress (Fix #3) ------------------------------------------------------------

describe("NeuralHttpBackend.getProgress", () => {
  it("returns null when no audio is playing", () => {
    const { fetchImpl } = makeFetch();
    const backend = makeBackend(fetchImpl, []);
    expect(backend.getProgress()).toBeNull();
  });

  it("returns null when audio duration is not finite yet (still buffering)", async () => {
    const { fetchImpl } = makeFetch();
    const audios: FakeAudio[] = [];
    const backend = makeBackend(fetchImpl, audios);
    backend.speak("Hi.", { rate: 1, voiceURI: null }, () => {});
    await flush();
    // duration is NaN by default in FakeAudio
    expect(backend.getProgress()).toBeNull();
  });

  it("returns { currentTime, duration } once duration is finite", async () => {
    const { fetchImpl } = makeFetch();
    const audios: FakeAudio[] = [];
    const backend = makeBackend(fetchImpl, audios);
    backend.speak("Hi.", { rate: 1, voiceURI: null }, () => {});
    await flush();
    audios[0].duration = 12.5;
    audios[0].currentTime = 3.0;
    const prog = backend.getProgress();
    expect(prog).toEqual({ currentTime: 3.0, duration: 12.5 });
  });

  it("returns null after cancel", async () => {
    const { fetchImpl } = makeFetch();
    const audios: FakeAudio[] = [];
    const backend = makeBackend(fetchImpl, audios);
    backend.speak("Hi.", { rate: 1, voiceURI: null }, () => {});
    await flush();
    audios[0].duration = 5;
    backend.cancel();
    expect(backend.getProgress()).toBeNull();
  });
});
