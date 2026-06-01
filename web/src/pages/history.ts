import type { SupabaseClient } from "@supabase/supabase-js";

// STUB — issue #12 fills this in.
//
// Contract: renderHistory(root, client) owns the `#/history` route. The route is
// already registered in router.ts, so #12 only edits THIS file plus appends
// history-specific queries to lib/supabase.ts. It must NOT edit main.ts/router.ts.
//
// It should guard the session the same way home.ts does (auth-gate for
// unauthenticated users) and render the per-topic digest history.

export async function renderHistory(root: HTMLElement, _client: SupabaseClient): Promise<void> {
  root.replaceChildren();
  const main = document.createElement("main");
  main.className = "app-main";
  main.setAttribute("data-testid", "history-placeholder");

  const h1 = document.createElement("h1");
  h1.textContent = "History";
  main.appendChild(h1);

  const p = document.createElement("p");
  p.textContent = "Digest history is coming soon.";
  main.appendChild(p);

  const back = document.createElement("a");
  back.href = "#/";
  back.textContent = "Back to today";
  main.appendChild(back);

  root.appendChild(main);
}
