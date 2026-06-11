# Self-hosted neural TTS (Kokoro-FastAPI)

Neural voice service for digest playback (#63). The web app synthesizes speech
against this endpoint when `VITE_TTS_NEURAL_URL` is set; otherwise it falls
back to the browser's Web Speech API.

## Deploy

On the host (e.g. the Strix Halo box), with Docker installed:

```bash
cd deploy/tts
docker compose up -d
```

The service listens on port **8880** and restarts automatically
(`restart: unless-stopped`). Image is pinned to
`ghcr.io/remsky/kokoro-fastapi-cpu:v0.5.0` — CPU inference is real-time on
this hardware.

## Endpoint contract

OpenAI-compatible speech API. The web client (`web/src/lib/tts-neural.ts`)
depends on exactly this shape:

```bash
# Synthesize: returns binary mp3 (24 kHz mono)
curl -X POST http://HOST:8880/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{
        "model": "kokoro",
        "input": "Hello from the digest reader.",
        "voice": "af_heart",
        "response_format": "mp3",
        "speed": 1.2
      }' \
  --output sample.mp3

# List voices: {"voices": [...]}
curl http://HOST:8880/v1/audio/voices
```

Default voice: `af_heart`.

## Wiring the web app

Set the endpoint in `web/.env` (build-time value, baked by Vite):

```
VITE_TTS_NEURAL_URL=http://HOST:8880
```

Leave it empty/unset to use Web Speech only. No secrets are involved — the
endpoint is unauthenticated on the LAN; do not expose port 8880 to the
public internet.

## CORS

The browser fetches cross-origin from the app origin to `:8880`, so the
service must answer with `Access-Control-Allow-Origin` for the app origin.
Verify:

```bash
curl -si http://HOST:8880/v1/audio/voices -H "Origin: http://APP-HOST:5173" \
  | grep -i access-control-allow-origin
```

If the header is missing, enable permissive CORS via the container's
environment in `docker-compose.yml` and re-verify before pointing the app at
it.

## Mixed content limit

An HTTPS-served app (e.g. the Cloudflare Pages deployment) cannot call an
`http://` endpoint — browsers block mixed content. Production simply leaves
`VITE_TTS_NEURAL_URL` unset (Web Speech fallback). Local/LAN use is
HTTP-to-HTTP and works.
