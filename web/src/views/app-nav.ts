import type { SupabaseClient } from "@supabase/supabase-js";
import { signOut } from "../lib/auth";

/** Canonical nav destinations in display order. */
const NAV_TABS: ReadonlyArray<readonly [string, string]> = [
  ["#/", "Today"],
  ["#/history", "History"],
  ["#/logs", "Logs"],
  ["#/source-health", "Source Health"],
  ["#/token-usage", "Token Usage"],
];

/**
 * Build the shared application nav.
 *
 * @param client   - Supabase client (used for sign-out).
 * @param activeHref - The exact href of the current page (e.g. `#/`, `#/history`).
 *                    The matching link receives `aria-current="page"` and the
 *                    `nav-active` class; it is NOT removed from the DOM.
 */
export function buildAppNav(client: SupabaseClient, activeHref: string): HTMLElement {
  const nav = document.createElement("nav");
  nav.className = "app-nav";

  for (const [href, label] of NAV_TABS) {
    const a = document.createElement("a");
    a.href = href;
    a.textContent = label;
    if (href === activeHref) {
      a.setAttribute("aria-current", "page");
      a.classList.add("nav-active");
    }
    nav.appendChild(a);
  }

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

  return nav;
}
