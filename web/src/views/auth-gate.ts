import type { SupabaseClient } from "@supabase/supabase-js";
import {
  challengeAndVerify,
  enrollTotp,
  getAalState,
  getCurrentSession,
  hasValidSession,
  isMfaSatisfied,
  listTotpFactor,
  nextGateStep,
  signInWithPassword,
  validateEmail,
  validatePassword,
  validateTotpCode,
  type GateStep,
} from "../lib/auth";

// The login gate. Shown in place of digest content until the session is signed in AND
// has satisfied any required second factor (AAL2). Multi-step:
//   password  -> sign in with email + password
//   enroll    -> first run: scan QR / enter secret, then verify a 6-digit code
//   challenge -> returning user with a verified factor: enter a 6-digit code
// On success the session reaches AAL2 and the page reloads to render digests.

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  attrs: Record<string, string> = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function statusEl(): HTMLParagraphElement {
  return el(
    "p",
    { className: "auth-status" },
    { role: "status", "aria-live": "polite", "data-testid": "auth-status" },
  );
}

function errorEl(): HTMLParagraphElement {
  return el(
    "p",
    { className: "auth-error" },
    { role: "alert", "aria-live": "assertive", "data-testid": "auth-error" },
  );
}

function reloadAuthenticated(): void {
  // Session is now AAL2; reload so the router re-renders digest content.
  window.location.reload();
}

function renderPasswordStep(wrap: HTMLElement, client: SupabaseClient): void {
  const blurb = el("p", { textContent: "Sign in with your email and password." });
  wrap.appendChild(blurb);

  const form = el("form", { className: "auth-form" }, { "data-testid": "password-form" });

  const emailLabel = el("label", { textContent: "Email" }, { for: "email" });
  const email = el(
    "input",
    {
      id: "email",
      name: "email",
      type: "email",
      required: true,
      autocomplete: "username",
      placeholder: "you@example.com",
    },
    { inputmode: "email" },
  );

  const pwLabel = el("label", { textContent: "Password" }, { for: "password" });
  const password = el("input", {
    id: "password",
    name: "password",
    type: "password",
    required: true,
    autocomplete: "current-password",
    placeholder: "Your password",
  });

  const button = el("button", { type: "submit", textContent: "Sign in" });
  const error = errorEl();

  form.append(emailLabel, email, pwLabel, password, button, error);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    error.textContent = "";
    const emailErr = validateEmail(email.value);
    if (emailErr) {
      error.textContent = emailErr;
      return;
    }
    const pwErr = validatePassword(password.value);
    if (pwErr) {
      error.textContent = pwErr;
      return;
    }
    void (async () => {
      button.disabled = true;
      const { error: signInErr } = await signInWithPassword(client, email.value, password.value);
      if (signInErr) {
        error.textContent = signInErr;
        button.disabled = false;
        return;
      }
      // Re-evaluate MFA state and advance to the right next step.
      await renderGate(wrap.parentElement as HTMLElement, client);
    })();
  });

  wrap.appendChild(form);
}

function renderCodeForm(opts: {
  wrap: HTMLElement;
  client: SupabaseClient;
  factorId: string;
  submitLabel: string;
  testid: string;
}): void {
  const { wrap, client, factorId, submitLabel, testid } = opts;
  const form = el("form", { className: "auth-form" }, { "data-testid": testid });

  const label = el("label", { textContent: "6-digit code" }, { for: "totp-code" });
  const code = el(
    "input",
    {
      id: "totp-code",
      name: "code",
      type: "text",
      required: true,
      autocomplete: "one-time-code",
      placeholder: "000000",
      maxLength: 6,
    },
    { inputmode: "numeric", pattern: "[0-9]*" },
  );

  const button = el("button", { type: "submit", textContent: submitLabel });
  const error = errorEl();
  form.append(label, code, button, error);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    error.textContent = "";
    const codeErr = validateTotpCode(code.value);
    if (codeErr) {
      error.textContent = codeErr;
      return;
    }
    void (async () => {
      button.disabled = true;
      const { error: verifyErr } = await challengeAndVerify(client, factorId, code.value);
      if (verifyErr) {
        error.textContent = verifyErr;
        button.disabled = false;
        return;
      }
      reloadAuthenticated();
    })();
  });

  wrap.appendChild(form);
}

async function renderEnrollStep(wrap: HTMLElement, client: SupabaseClient): Promise<void> {
  const blurb = el("p", {
    textContent:
      "Set up two-factor authentication. Scan the QR code with an authenticator app " +
      "(or enter the secret manually), then enter the 6-digit code.",
  });
  wrap.appendChild(blurb);

  const status = statusEl();
  status.textContent = "Preparing enrollment…";
  wrap.appendChild(status);

  const { factorId, qrCode, secret, error } = await enrollTotp(client);
  if (error || !factorId || !qrCode || !secret) {
    status.textContent = error ?? "Could not start enrollment.";
    return;
  }
  status.textContent = "";

  const qr = el("img", { src: qrCode, alt: "TOTP QR code" }, { class: "mfa-qr", "data-testid": "mfa-qr" });
  wrap.appendChild(qr);

  const secretLabel = el("p", { className: "mfa-secret-label", textContent: "Or enter this secret manually:" });
  const secretEl = el(
    "code",
    { className: "mfa-secret", textContent: secret },
    { "data-testid": "mfa-secret" },
  );
  wrap.append(secretLabel, secretEl);

  renderCodeForm({
    wrap,
    client,
    factorId,
    submitLabel: "Verify & enable",
    testid: "enroll-verify-form",
  });
}

async function renderChallengeStep(
  wrap: HTMLElement,
  client: SupabaseClient,
  factorId: string,
): Promise<void> {
  const blurb = el("p", {
    textContent: "Enter the 6-digit code from your authenticator app.",
  });
  wrap.appendChild(blurb);
  renderCodeForm({
    wrap,
    client,
    factorId,
    submitLabel: "Verify",
    testid: "challenge-form",
  });
}

async function renderGate(root: HTMLElement, client: SupabaseClient): Promise<void> {
  root.replaceChildren();

  const wrap = el("main", { className: "auth-gate" }, { "data-testid": "auth-gate" });
  const h1 = el("h1", { textContent: "News Digest" });
  wrap.appendChild(h1);
  root.appendChild(wrap);

  // Determine the current step.
  const session = await getCurrentSession(client);
  const hasSession = hasValidSession(session);
  let step: GateStep;
  let factorId: string | null = null;
  if (!hasSession) {
    step = "password";
  } else {
    const [aal, totp] = await Promise.all([getAalState(client), listTotpFactor(client)]);
    factorId = totp.factorId;
    step = nextGateStep({
      hasSession,
      hasVerifiedTotp: totp.verified,
      mfaSatisfied: isMfaSatisfied(aal),
    });
  }

  if (step === "done") {
    // Already satisfied — let the caller render content.
    reloadAuthenticated();
    return;
  }

  if (step === "password") {
    renderPasswordStep(wrap, client);
    return;
  }
  if (step === "challenge" && factorId) {
    await renderChallengeStep(wrap, client, factorId);
    return;
  }
  // enroll (first run, or no verified factor yet)
  await renderEnrollStep(wrap, client);
}

export function renderAuthGate(root: HTMLElement, client: SupabaseClient): void {
  void renderGate(root, client);
}
