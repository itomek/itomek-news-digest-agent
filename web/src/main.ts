import "./components/playback"; // #11: auto-registers TTS playback controls
import "./components/feedback"; // #22: auto-registers feedback controls
import { getSupabase } from "./lib/supabase";
import { renderHome } from "./pages/home";
import { renderHistory } from "./pages/history";
import { renderLogs } from "./pages/logs";
import { renderSourceHealthPage } from "./pages/source-health";
import { renderTokenUsagePage } from "./pages/token-usage";
import { registerRoute, startRouter } from "./router";

// App bootstrap. Routes are declared here once; pages live in their own files.
// #11 (TTS) and #12 (history) should NOT need to touch this file:
//   - #12 fills pages/history.ts (route already wired below).
//   - #11 registers playback controls via views/digest-card.registerPlaybackControls
//     from its own module imported here later, or auto-registers on import.

const root = document.getElementById("app");
if (!root) throw new Error("Missing #app root element");

const client = getSupabase();

// Expose the anon client for e2e RLS assertions. Safe: anon/publishable key only,
// already present in the bundle. Not a secret.
(window as unknown as { __supabase?: typeof client }).__supabase = client;

registerRoute("/", renderHome);
registerRoute("/history", renderHistory);
registerRoute("/logs", renderLogs);
registerRoute("/source-health", renderSourceHealthPage);
registerRoute("/token-usage", renderTokenUsagePage);

startRouter(root, client);
