// Supabase Edge Function: `tts` — OpenAI-style TTS proxy over Google Cloud TTS.
//
// Presents the contract the web client (web/src/lib/tts-neural.ts) speaks:
//   GET  <base>/v1/audio/voices  -> { voices: [{ id, name }] }
//   POST <base>/v1/audio/speech  { model, input, voice, response_format, speed }
//                                -> binary audio/mpeg
//
// The Google API key lives in the function's secrets (GOOGLE_TTS_API_KEY),
// never in the repo or the browser. Deployed with JWT verification ON, so
// callers must present a Supabase bearer token. Never logs input text or the
// key. Path matching is suffix-based because the function mount prefix varies
// by invocation style (/tts/... vs /functions/v1/tts/...).

import {
  clampSpeed,
  friendlyLabel,
  languageCodeOf,
  pickVoices,
  type GoogleVoice,
} from "./helpers.ts";

const GOOGLE_BASE = "https://texttospeech.googleapis.com/v1";
const DEFAULT_VOICE = Deno.env.get("TTS_DEFAULT_VOICE") ?? "en-US-Chirp3-HD-Aoede";

function corsHeaders(req: Request): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": req.headers.get("origin") ?? "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

function jsonResponse(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

async function handleVoices(req: Request, key: string): Promise<Response> {
  // Key travels in a header, never in the URL, so it can't surface in logs.
  const res = await fetch(`${GOOGLE_BASE}/voices?languageCode=en-US`, {
    headers: { "X-Goog-Api-Key": key },
  });
  if (!res.ok) {
    return jsonResponse(req, res.status, { error: "voice list fetch failed" });
  }
  const data = (await res.json()) as { voices?: GoogleVoice[] };
  const voices = pickVoices(data.voices ?? []).map((v) => ({
    id: v.name,
    name: friendlyLabel(v.name),
  }));
  return jsonResponse(req, 200, { voices });
}

async function handleSpeech(req: Request, key: string): Promise<Response> {
  let body: { input?: unknown; voice?: unknown; speed?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse(req, 400, { error: "invalid JSON body" });
  }

  const input = typeof body.input === "string" ? body.input.trim() : "";
  if (!input) return jsonResponse(req, 400, { error: "input must be a non-empty string" });
  // Server-side quota guard: the client chunks at 4000 chars, so anything well
  // past that is not our app.
  if (input.length > 5000) return jsonResponse(req, 400, { error: "input too long" });

  const voice =
    typeof body.voice === "string" && body.voice.trim() ? body.voice.trim() : DEFAULT_VOICE;

  const res = await fetch(`${GOOGLE_BASE}/text:synthesize`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key },
    body: JSON.stringify({
      input: { text: input },
      voice: { languageCode: languageCodeOf(voice), name: voice },
      audioConfig: { audioEncoding: "MP3", speakingRate: clampSpeed(body.speed) },
    }),
  });

  if (!res.ok) {
    // Pass the status through with a sanitized message — Google error bodies
    // can include the request URL (and so the key); never echo the key.
    let message = "synthesis failed";
    try {
      const err = (await res.json()) as { error?: { message?: string } };
      if (err.error?.message) message = err.error.message.replaceAll(key, "[redacted]");
    } catch {
      // keep the generic message
    }
    return jsonResponse(req, res.status, { error: message });
  }

  const data = (await res.json()) as { audioContent?: string };
  if (!data.audioContent) return jsonResponse(req, 502, { error: "no audio returned" });

  const bytes = Uint8Array.from(atob(data.audioContent), (c) => c.charCodeAt(0));
  return new Response(bytes, {
    status: 200,
    headers: { ...corsHeaders(req), "Content-Type": "audio/mpeg" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  const key = Deno.env.get("GOOGLE_TTS_API_KEY");
  if (!key) return jsonResponse(req, 500, { error: "TTS not configured" });

  const path = new URL(req.url).pathname;
  if (req.method === "GET" && path.endsWith("/v1/audio/voices")) {
    return handleVoices(req, key);
  }
  if (req.method === "POST" && path.endsWith("/v1/audio/speech")) {
    return handleSpeech(req, key);
  }
  return jsonResponse(req, 404, { error: "not found" });
});
