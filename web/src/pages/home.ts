import type { SupabaseClient } from "@supabase/supabase-js";
import {
  changePassword,
  isAuthenticatedAtRequiredLevel,
  signOut,
  validatePassword,
} from "../lib/auth";
import { fetchDigests, fetchTopics } from "../lib/supabase";
import { renderAuthGate } from "../views/auth-gate";
import { renderDigestList } from "../views/digest-list";

// Home page: auth gate for unauthenticated/AAL1 users, grouped digest list otherwise.

/** Minimal authenticated Account control: change the (initially temporary) password. */
function renderAccount(client: SupabaseClient): HTMLElement {
  const section = document.createElement("section");
  section.className = "account";
  section.setAttribute("data-testid", "account");

  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Account";
  details.appendChild(summary);

  const form = document.createElement("form");
  form.className = "auth-form account-form";
  form.setAttribute("data-testid", "change-password-form");

  const label = document.createElement("label");
  label.setAttribute("for", "new-password");
  label.textContent = "New password";
  const input = document.createElement("input");
  input.id = "new-password";
  input.name = "new-password";
  input.type = "password";
  input.autocomplete = "new-password";
  input.placeholder = "New password";

  const button = document.createElement("button");
  button.type = "submit";
  button.textContent = "Change password";

  const status = document.createElement("p");
  status.className = "auth-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  form.append(label, input, button, status);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    status.textContent = "";
    const err = validatePassword(input.value);
    if (err) {
      status.textContent = err;
      return;
    }
    void (async () => {
      button.disabled = true;
      status.textContent = "Updating…";
      const { error } = await changePassword(client, input.value);
      button.disabled = false;
      status.textContent = error ? `Could not update password: ${error}` : "Password updated.";
      if (!error) input.value = "";
    })();
  });

  details.appendChild(form);
  section.appendChild(details);
  return section;
}

export async function renderHome(root: HTMLElement, client: SupabaseClient): Promise<void> {
  if (!(await isAuthenticatedAtRequiredLevel(client))) {
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

  root.appendChild(renderAccount(client));

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
