import { SUPABASE_URL, serverEnv } from "../config"
import { AdminError } from "./roster"

/**
 * Service-role access to `access_requests` / `physicians`, for the admin
 * dashboard's Access Requests panel.
 *
 * Approving used to happen via a bearer token riding in a Telegram button's
 * callback_data — replayable by anyone in that chat or holding the bot
 * token, straight against Supabase, with no admin session involved at all
 * (SECURITY_ANALYSIS.md §2c). This is the replacement: the admin's own
 * authenticated dashboard, writing with the service-role key server-side,
 * same posture as the roster CRUD in roster.ts.
 */

export interface AccessRequest {
  email: string
  name: string | null
  department: string | null
  requested_at: string
  request_count: number
}

function serviceHeaders(): Record<string, string> {
  const key = serverEnv.supabaseServiceRoleKey()
  if (!key) throw new AdminError("SUPABASE_SERVICE_ROLE_KEY is not set", 500)
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  }
}

export async function listAccessRequests(): Promise<AccessRequest[]> {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/access_requests?resolved=is.false&select=*&order=requested_at.desc`,
    { headers: serviceHeaders(), signal: AbortSignal.timeout(8000) },
  )
  if (!response.ok) throw new AdminError("failed to load access requests", 500)
  return (await response.json()) as AccessRequest[]
}

async function markResolved(email: string): Promise<void> {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/access_requests?email=eq.${encodeURIComponent(email)}`,
    { method: "PATCH", headers: serviceHeaders(), body: JSON.stringify({ resolved: true }), signal: AbortSignal.timeout(8000) },
  )
  if (!response.ok) throw new AdminError("failed to mark request resolved", 500)
}

/**
 * Upsert rather than insert: the email may already exist (e.g. a previously
 * revoked physician re-requesting) — approving should re-activate that row,
 * not fail on the primary key.
 */
export async function approveAccessRequest(email: string): Promise<void> {
  const reqRes = await fetch(
    `${SUPABASE_URL}/rest/v1/access_requests?email=eq.${encodeURIComponent(email)}&select=name,department`,
    { headers: serviceHeaders(), signal: AbortSignal.timeout(8000) },
  )
  if (!reqRes.ok) throw new AdminError("failed to load access request", 500)
  const rows = (await reqRes.json()) as Array<{ name: string | null; department: string | null }>
  const name = rows[0]?.name ?? null
  const department = rows[0]?.department ?? null

  // department is omitted from the body entirely when the request never
  // captured one (logged before this field existed) — merge-duplicates only
  // overwrites columns present in the payload, so leaving it out preserves
  // whatever department the physicians row already has rather than
  // clobbering it with null.
  const upsertBody: Record<string, unknown> = {
    email,
    full_name: name,
    source: "directory",
    active: true,
    updated_at: new Date().toISOString(),
  }
  if (department) upsertBody.department = department

  const upsert = await fetch(`${SUPABASE_URL}/rest/v1/physicians?on_conflict=email`, {
    method: "POST",
    headers: { ...serviceHeaders(), Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify(upsertBody),
    signal: AbortSignal.timeout(8000),
  })
  if (!upsert.ok) {
    const body = (await upsert.json().catch(() => null)) as { message?: string } | null
    throw new AdminError(body?.message ?? "approve failed", 400)
  }

  await markResolved(email)
}

export async function rejectAccessRequest(email: string): Promise<void> {
  await markResolved(email)
}
