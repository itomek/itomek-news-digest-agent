/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  /** Base URL of the self-hosted neural TTS endpoint (Kokoro-FastAPI). Empty/unset → Web Speech fallback. */
  readonly VITE_TTS_NEURAL_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
