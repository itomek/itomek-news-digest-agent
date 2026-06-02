// auth-allowlist — Supabase Auth "before user created" hook (alternative to the
// 0003 Postgres trigger; both enforce the same allowlist). Wire this in the
// Supabase dashboard under Authentication > Hooks > "Before user created" if you
// prefer rejecting BEFORE the user row is created (cleaner than the delete-after
// approach the trigger uses). The allowlist source of truth is the
// public.digest_allowlist table.
//
// Deploy: supabase functions deploy auth-allowlist --no-verify-jwt
// (Auth hooks are called by GoTrue with a shared secret, not a user JWT.)
//
// Request body (Auth hook v1): { user: { email, ... }, ... }
// Response to ALLOW: { } (200). Response to REJECT: 200 with an `error` object.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req: Request) => {
  let payload: { user?: { email?: string } };
  try {
    payload = await req.json();
  } catch {
    return json({ error: { http_code: 400, message: "Invalid JSON body" } });
  }

  const email = payload.user?.email?.trim().toLowerCase();
  if (!email) {
    return json({ error: { http_code: 400, message: "Missing email" } });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data, error } = await admin
    .from("digest_allowlist")
    .select("email")
    .ilike("email", email)
    .maybeSingle();

  if (error) {
    return json({ error: { http_code: 500, message: "Allowlist lookup failed" } });
  }

  if (!data) {
    return json({
      error: { http_code: 403, message: "This email is not authorized to sign in." },
    });
  }

  // Allowed — empty object lets the user be created.
  return json({});
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}
