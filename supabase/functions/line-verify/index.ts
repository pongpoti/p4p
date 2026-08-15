// ============================================================================
//  P4P — line-verify: the whole LINE half of login, as a Supabase Edge
//  Function instead of a Vercel route.
// ============================================================================
//  Called directly from the browser (verify/app.js), not through main.js.
//  Two modes, matching the two moments verify/app.js needs LINE identity:
//
//    mode: "bind"   — right after email OTP verifyOtp() succeeds. Body:
//                     { mode: "bind", access_token, id_token }.
//                     Validates the fresh Supabase session (-> email),
//                     verifies id_token with LINE (-> line_user_id), and
//                     writes both onto the matching `physicians` row.
//                     Never blocks login: this only records traceability,
//                     it is not a second auth factor (see
//                     scripts/auth-rewrite-2026-08.sql for why).
//
//    mode: "silent" — on page load, before any session exists. Body:
//                     { mode: "silent", id_token }.
//                     Verifies id_token with LINE, looks up `physicians` by
//                     line_user_id, and — if that email is bound and active —
//                     mints a fresh Supabase session server-side (no OTP
//                     typed, no email sent) and returns the tokens. The
//                     caller (verify/app.js) still has to hand those tokens
//                     to the app's own same-origin /auth/session so it can
//                     set the HttpOnly cookie; an Edge Function on
//                     *.supabase.co cannot set a cookie for the app's own
//                     domain.
//
//  SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically by
//  the Edge Functions runtime — nothing to configure for those. The one
//  secret this function needs set explicitly is LINE_LOGIN_CHANNEL_ID (the
//  LINE **Login** channel that owns the /verify/ LIFF app — NOT the
//  Messaging API channel main.js's bot uses):
//
//    supabase secrets set LINE_LOGIN_CHANNEL_ID=xxxxxxxxxx
//
//  Deploy with verify_jwt disabled (see supabase/config.toml) — this
//  function must be callable with NO Supabase session yet (the "silent"
//  case runs before one exists), and it authenticates callers itself:
//  LINE vouches for the id_token, GoTrue vouches for the access_token.
//
//    supabase functions deploy line-verify
//
//  Not deployed by this change — no Supabase CLI / project credentials are
//  available in this environment. Deploying and setting the secret above
//  are the two manual steps needed before verify/app.js's calls will work.
// ============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!
const LINE_LOGIN_CHANNEL_ID = Deno.env.get("LINE_LOGIN_CHANNEL_ID")

// Restrict CORS to the app's own origin(s) rather than "*" — this endpoint
// mints sessions, so it's worth being deliberate about who can call it from
// a browser context. Comma-separated; falls back to "*" only if unset, so a
// misconfigured deploy fails open to permissive rather than failing closed
// to unusable (this is a public-anon-callable endpoint by design, same
// posture as is_sender_allowlisted — LINE/GoTrue are the real gate).
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)

function corsHeaders(origin: string | null): HeadersInit {
  const allow =
    ALLOWED_ORIGINS.includes("*") || (origin && ALLOWED_ORIGINS.includes(origin))
      ? (origin ?? "*")
      : ALLOWED_ORIGINS[0]
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  }
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  })
}

// Ask LINE whether a LIFF ID token is genuine. LINE checks signature, expiry
// and audience for us; `sub` is the authoritative LINE userId — not
// something the browser can assert on its own (liff.getProfile() is just a
// string the page chooses to send; an ID token is signed by LINE).
async function verifyLineIdToken(idToken: string): Promise<{ sub: string; name: string | null } | null> {
  if (!LINE_LOGIN_CHANNEL_ID) {
    console.error("[line-verify] LINE_LOGIN_CHANNEL_ID is not set")
    return null
  }
  try {
    const r = await fetch("https://api.line.me/oauth2/v2.1/verify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id_token: idToken, client_id: LINE_LOGIN_CHANNEL_ID }),
    })
    if (!r.ok) {
      console.error("[line-verify] LINE rejected the id_token:", r.status, await r.text())
      return null
    }
    const data = await r.json()
    if (!data.sub) return null
    return { sub: data.sub as string, name: (data.name as string) || null }
  } catch (e) {
    console.error("[line-verify] LINE verify call failed:", e)
    return null
  }
}

// Resolve the email behind a Supabase access token by asking GoTrue directly
// — not by decoding the JWT body — so a session revoked/expired server-side
// can't be used here even if the token still parses.
async function emailForAccessToken(accessToken: string): Promise<string | null> {
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${accessToken}` },
    })
    if (!r.ok) return null
    const data = await r.json()
    return (data.email as string) || null
  } catch (e) {
    console.error("[line-verify] access_token validation failed:", e)
    return null
  }
}

// service_role REST helper — the function's own credential, never the
// caller's. Used for the physicians read/write, which RLS otherwise blocks
// entirely for anon/authenticated (see scripts/auth-rewrite-2026-08.sql).
async function supaRest(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  })
}

// mode: "bind" — record traceability for an already-logged-in session.
// Never a login-blocking failure: any problem here is logged and reported
// back as {ok:false}, but the caller's Supabase session (already minted by
// verifyOtp before this was ever called) stays valid regardless.
async function handleBind(body: { access_token?: string; id_token?: string }, origin: string | null) {
  const { access_token, id_token } = body
  if (!access_token || !id_token) return json({ ok: false, error: "missing token" }, 400, origin)

  const email = await emailForAccessToken(access_token)
  if (!email) return json({ ok: false, error: "invalid session" }, 401, origin)

  const line = await verifyLineIdToken(id_token)
  if (!line) return json({ ok: false, error: "line verification failed" }, 401, origin)

  const r = await supaRest(`physicians?email=eq.${encodeURIComponent(email.toLowerCase())}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      line_user_id: line.sub,
      line_display_name: line.name,
      last_login_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
  })
  if (!r.ok) {
    console.error("[line-verify] physicians update failed:", r.status, await r.text())
    return json({ ok: false, error: "write failed" }, 500, origin)
  }
  console.log(`[line-verify] bind ${email} -> ${line.sub}`)
  return json({ ok: true }, 200, origin)
}

// mode: "silent" — resume a session for a RETURNING bound physician using
// only LINE's own (persistent) login, no OTP typed. Can only ever RESUME a
// binding the real email+OTP+id-token flow already created via "bind" above
// — this looks up line_user_id -> email, never the other direction, so
// there is nothing here that could let someone claim an email they don't
// control.
async function handleSilent(body: { id_token?: string }, origin: string | null) {
  const { id_token } = body
  if (!id_token) return json({ ok: false, error: "missing id_token" }, 400, origin)

  const line = await verifyLineIdToken(id_token)
  if (!line) return json({ ok: false, error: "line verification failed" }, 401, origin)

  const lookup = await supaRest(
    `physicians?line_user_id=eq.${encodeURIComponent(line.sub)}&active=is.true&select=email&limit=1`,
  )
  if (!lookup.ok) {
    console.error("[line-verify] physicians lookup failed:", lookup.status, await lookup.text())
    return json({ ok: false, error: "lookup failed" }, 500, origin)
  }
  const rows = (await lookup.json()) as Array<{ email: string }>
  const email = rows[0]?.email
  if (!email) return json({ ok: false, reason: "not_bound" }, 200, origin) // normal case, not an error

  try {
    const session = await mintSessionForEmail(email)
    await supaRest(`physicians?email=eq.${encodeURIComponent(email)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ last_login_at: new Date().toISOString() }),
    })
    console.log(`[line-verify] silent auth minted session for ${email}`)
    return json({ ok: true, session }, 200, origin)
  } catch (e) {
    console.error("[line-verify] mint failed:", e)
    return json({ ok: false, error: "mint failed" }, 500, origin)
  }
}

// Generates a magic-link OTP for an existing user and immediately redeems it
// server-side, entirely with our own credentials — two GoTrue calls,
// service-role then anon, the same technique main.js used for
// /line/silent-auth before this moved here. Nothing is emailed; the OTP is
// consumed in the very next call.
async function mintSessionForEmail(email: string): Promise<{ access_token: string; refresh_token: string }> {
  const genRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type: "magiclink", email }),
  })
  if (!genRes.ok) throw new Error(`generate_link failed: ${genRes.status} ${await genRes.text()}`)
  const gen = await genRes.json()
  const otp: string | undefined = gen.email_otp || gen.properties?.email_otp
  if (!otp) throw new Error("generate_link returned no email_otp")

  const verifyRes = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "email", email, token: otp }),
  })
  if (!verifyRes.ok) throw new Error(`verify failed: ${verifyRes.status} ${await verifyRes.text()}`)
  const verified = await verifyRes.json()
  if (!verified.access_token || !verified.refresh_token) throw new Error("verify returned no session")
  return { access_token: verified.access_token, refresh_token: verified.refresh_token }
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin")

  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(origin) })
  if (req.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405, origin)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400, origin)
  }

  switch (body.mode) {
    case "bind":
      return handleBind(body as { access_token?: string; id_token?: string }, origin)
    case "silent":
      return handleSilent(body as { id_token?: string }, origin)
    default:
      return json({ ok: false, error: "mode must be 'bind' or 'silent'" }, 400, origin)
  }
})
