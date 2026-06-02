import type { SupabaseClient } from "@supabase/supabase-js";
import { getCurrentSession, hasValidSession, signOut } from "../lib/auth";
import { fetchDigests, fetchTopics } from "../lib/supabase";
import { renderAuthGate } from "../views/auth-gate";
import { renderDigestList } from "../views/digest-list";

// Home page: auth gate for unauthenticated users, grouped digest list otherwise.

export async function renderHome(root: HTMLElement, client: SupabaseClient): Promise<void> {
  const session = await getCurrentSession(client);
  if (!hasValidSession(session)) {
    renderAuthGate(root, client);
    return;
  }

  root.replaceChildren();

  const header = document.createElement("header");
  header.className = "app-header";

  const title = document.createElement("h1");
  title.textContent = "News Digest";
  header.appendChild(title);

  const nav = document.createElement("nav");
  nav.className = "app-nav";
  const historyLink = document.createElement("a");
  historyLink.href = "#/history";
  historyLink.textContent = "History";
  nav.appendChild(historyLink);

  const out = document.createElement("button");
  out.type = "button";
  out.className = "sign-out";
  out.textContent = "Sign out";
  out.addEventListener("click", () => {
    void (async () => {
      await signOut(client);
      window.location.hash = "#/";
      window.location.reload();
    })();
  });
  nav.appendChild(out);
  header.appendChild(nav);
  root.appendChild(header);

  const main = document.createElement("main");
  main.className = "app-main";
  main.setAttribute("data-testid", "digest-content");
  const loading = document.createElement("p");
  loading.textContent = "Loading digests…";
  main.appendChild(loading);
  root.appendChild(main);

  try {
    const [digests, topics] = await Promise.all([fetchDigests(client), fetchTopics(client)]);
    main.replaceChildren(renderDigestList(digests, topics));
  } catch (err) {
    main.replaceChildren();
    const msg = document.createElement("p");
    msg.className = "error-state";
    msg.textContent = `Could not load digests: ${(err as Error).message}`;
    main.appendChild(msg);
  }
}
