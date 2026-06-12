import type { SupabaseClient } from "@supabase/supabase-js";
import {
  changePassword,
  isAuthenticatedAtRequiredLevel,
  signOut,
  validatePassword,
} from "../lib/auth";
import { fetchDigests, fetchMissedDigestWarnings, fetchTopics } from "../lib/supabase";
import type { SystemLog } from "../lib/types";
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
  const logsLink = document.createElement("a");
  logsLink.href = "#/logs";
  logsLink.textContent = "Logs";
  nav.appendChild(logsLink);
  const sourceHealthLink = document.createElement("a");
  sourceHealthLink.href = "#/source-health";
  sourceHealthLink.textContent = "Source Health";
  nav.appendChild(sourceHealthLink);
  const tokenUsageLink = document.createElement("a");
  tokenUsageLink.href = "#/token-usage";
  tokenUsageLink.textContent = "Token Usage";
  nav.appendChild(tokenUsageLink);

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
    // Fetch digests, topics, and missed-digest warnings in parallel.
    // Missed-digest fetch failure is non-fatal — banner simply won't appear.
    const [digests, topics, missedWarnings] = await Promise.all([
      fetchDigests(client),
      fetchTopics(client),
      fetchMissedDigestWarnings(client, 48).catch((): SystemLog[] => []),
    ]);

    main.replaceChildren();

    if (missedWarnings.length > 0) {
      main.appendChild(renderMissedDigestBanner(missedWarnings));
    }

    main.appendChild(renderDigestList(digests, topics));
  } catch (err) {
    main.replaceChildren();
    const msg = document.createElement("p");
    msg.className = "error-state";
    msg.textContent = `Could not load digests: ${(err as Error).message}`;
    main.appendChild(msg);
  }
}

/** Render a warning banner listing topics with missed digests. */
function renderMissedDigestBanner(warnings: SystemLog[]): HTMLElement {
  const banner = document.createElement("aside");
  banner.className = "missed-digest-banner";
  banner.setAttribute("role", "alert");
  banner.setAttribute("data-testid", "missed-digest-banner");

  const heading = document.createElement("strong");
  heading.textContent = "Missed digest alerts";
  banner.appendChild(heading);

  const list = document.createElement("ul");
  list.className = "missed-digest-list";
  for (const w of warnings) {
    const li = document.createElement("li");
    const meta = w.metadata as Record<string, unknown> | null;
    const slug = (meta?.["topic_slug"] as string | undefined) ?? w.topic_slug ?? "unknown";
    const cadence = (meta?.["cadence"] as string | undefined) ?? "";
    li.textContent = cadence ? `${slug} (${cadence})` : slug;
    list.appendChild(li);
  }
  banner.appendChild(list);

  const note = document.createElement("p");
  note.className = "missed-digest-note";
  note.textContent = "No digest was published within the expected window. Check the agent or ";
  const logsLink = document.createElement("a");
  logsLink.href = "#/logs";
  logsLink.textContent = "view logs";
  note.appendChild(logsLink);
  note.appendChild(document.createTextNode("."));
  banner.appendChild(note);

  return banner;
}
