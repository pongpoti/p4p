/**
 * The single boolean gate check.
 *
 * Whether a LINE account is bound plays no part in this — that's
 * traceability recorded by supabase/functions/line-verify, never a
 * condition for reaching a gated page. See scripts/auth-rewrite-2026-08.sql.
 */
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "../config"

/**
 * Is this session's email still allowed to be here — active in
 * `physicians`, and (as of auth-rewrite-2026-08.sql) not sitting on a
 * revoked Supabase session either. Called with the USER'S access token, not
 * the anon key; the RPC reads the email from the caller's own JWT rather
 * than taking one as a parameter, so there is nothing here for an
 * unauthenticated caller to enumerate.
 *
 * Fails OPEN on a transient Supabase error rather than locking out a whole
 * hospital over a network blip — RLS is still the real data barrier
 * regardless of what this returns.
 */
export async function isCurrentUserAllowlisted(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(`${SUPABASE_URL}/rest/v1/rpc/is_current_user_allowlisted`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) {
      console.error(`[gate] is_current_user_allowlisted failed: ${response.status}`)
      return true
    }
    return (await response.json()) === true
  } catch (err) {
    console.error("[gate] is_current_user_allowlisted failed:", err)
    return true
  }
}

export type GateAction = { type: "serve" } | { type: "blocked" }

/** Pure — no I/O, no framework. Kept as a function (rather than inlining the
 *  one branch at the call site) so middleware reads as a straight decision
 *  table, matching the shape the rest of lib/gate/ uses. */
export function gateDecision(allowed: boolean): GateAction {
  return allowed ? { type: "serve" } : { type: "blocked" }
}
