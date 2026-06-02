import type { SupabaseClient } from "@supabase/supabase-js";
import { sendMagicLink } from "../lib/auth";

// The login gate. Shown to unauthenticated users in place of digest content.

export function renderAuthGate(root: HTMLElement, client: SupabaseClient): void {
  root.replaceChildren();

  const wrap = document.createElement("main");
  wrap.className = "auth-gate";
  wrap.setAttribute("data-testid", "auth-gate");

  const h1 = document.createElement("h1");
  h1.textContent = "News Digest";
  wrap.appendChild(h1);

  const blurb = document.createElement("p");
  blurb.textContent = "Sign in with a magic link to read your digests.";
  wrap.appendChild(blurb);

  const form = document.createElement("form");
  form.className = "auth-form";

  const label = document.createElement("label");
  label.setAttribute("for", "email");
  label.textContent = "Email";
  form.appendChild(label);

  const input = document.createElement("input");
  input.id = "email";
  input.name = "email";
  input.type = "email";
  input.required = true;
  input.autocomplete = "email";
  input.inputMode = "email";
  input.placeholder = "you@example.com";
  form.appendChild(input);

  const button = document.createElement("button");
  button.type = "submit";
  button.textContent = "Send magic link";
  form.appendChild(button);

  const status = document.createElement("p");
  status.className = "auth-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  form.appendChild(status);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void (async () => {
      button.disabled = true;
      status.textContent = "Sending…";
      const redirectTo = window.location.origin + window.location.pathname;
      const { error } = await sendMagicLink(client, input.value, redirectTo);
      if (error) {
        status.textContent = `Could not send link: ${error}`;
        button.disabled = false;
        return;
      }
      status.textContent =
        "If that email has an account, a sign-in link is on its way. Check your inbox.";
    })();
  });

  wrap.appendChild(form);
  root.appendChild(wrap);
}
