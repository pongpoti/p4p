/**
 * scripts/dashboard-users-2026-11.sql, read as text: it pastes through chat
 * (no backslash, under 24 KB), keeps both tables and every function to the
 * service role, never stores the QR token itself, and carries no LINE ID,
 * name or picture (this repository is public).
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const src = readFileSync(resolve(root, "scripts/dashboard-users-2026-11.sql"), "utf8")
const code = src.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")

test("pastes through chat: no backslash, no E'' string, under 24 KB", () => {
  assert.equal(src.includes("\\"), false)
  assert.equal(/(^|[^a-z0-9_])e'/i.test(code), false)
  assert.ok(Buffer.byteLength(src) < 24 * 1024, Buffer.byteLength(src) + " bytes")
})

test("both tables: RLS on, service role only, no delete", () => {
  for (const t of ["dashboard_users", "dashboard_invites"]) {
    assert.match(code, new RegExp("create table if not exists public\\." + t + " \\("))
    assert.match(code, new RegExp("alter table public\\." + t + " enable row level security;"))
    assert.match(code, new RegExp("revoke all on table public\\." + t + " from public, anon, authenticated;"))
    assert.match(code, new RegExp("grant select, insert, update on table public\\." + t + " to service_role;"))
    assert.match(code, new RegExp("revoke delete, truncate on table public\\." + t + " from service_role;"))
  }
  assert.doesNotMatch(code, /grant [^;]*delete/i)
  // The closing check covers all ten functions for anon, and the no-delete rule.
  const check = code.slice(code.lastIndexOf("select\n"))
  assert.equal((check.match(/'dashboard_[a-z_]+'/g) || []).length, 22)
  assert.match(check, /has_table_privilege\('service_role', t, 'delete'\)/)
})

test("every function: fixed search path, revoked from anon, granted to the service role", () => {
  const fns = [...code.matchAll(/create or replace function public\.(\w+)\(([^)]*)\)/g)]
  assert.equal(fns.length, 10)
  for (const [, name] of fns) {
    const body = code.slice(code.indexOf("function public." + name + "("))
    assert.match(body.slice(0, body.indexOf("$$;")), /set search_path = ''/, name)
    assert.match(code, new RegExp("revoke all on function public\\." + name + "\\([^)]*\\) from public, anon, authenticated;"), name)
    assert.match(code, new RegExp("grant execute on function public\\." + name + "\\([^)]*\\) to service_role;"), name)
  }
})

test("the QR: only a hash, one open per owner, 10 minutes to scan, 24 hours to decide", () => {
  assert.match(code, /token_hash\s+text not null unique check \(token_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/)
  assert.doesNotMatch(code, /\btoken\s+text/)
  assert.match(code, /create unique index if not exists dashboard_invites_one_open\s+on public\.dashboard_invites \(created_by\) where status = 'open'/)
  assert.match(code, /now\(\) \+ interval '10 minutes'/)
  assert.match(code, /expires_at = now\(\) \+ interval '24 hours'/)
  assert.match(code, /if v_n >= 10 then raise exception 'dashboard: rate_limited'/)
})

test("the claim is first-come under a row lock; approve checks the code and locks on the third miss", () => {
  assert.match(code, /where token_hash = p_token_hash for update/)
  assert.match(code, /if v\.status = 'open' and v\.expires_at > now\(\) then\s+update public\.dashboard_invites\s+set status = 'scanned'/)
  assert.match(code, /if not found or v\.status <> 'scanned' then return jsonb_build_object\('result', 'not_pending'\)/)
  assert.match(code, /p_code <> v\.confirm_code/)
  assert.match(code, /status = case when v_tries >= 3 then 'locked' else status end/)
  // The user approved is the one LINE verified at the scan.
  assert.match(code, /values \(v\.claimed_sub, coalesce\(v\.claimed_name, ''\), v_name, v_perms, true, 'qr', p_actor\)/)
  assert.match(code, /active and line_user_id <> v\.claimed_sub\) >= 20/)
})

test("rights are checked in the database too", () => {
  assert.match(code, /perms <@ array\['followup\.view','followup\.edit','roster\.view','staffing\.view','review\.auditee'\]::text\[\]/)
  assert.match(code, /if 'followup\.edit' = any \(v\) then v := v \|\| 'followup\.view'::text; end if;/)
  // The env import gives exactly the ผู้จัดทำ set and never changes a row.
  assert.match(code, /array\['followup\.edit','followup\.view','review\.auditee','roster\.view','staffing\.view'\]::text\[\],\s+true, 'env', p_sub\)\s+on conflict \(line_user_id\) do nothing/)
})

test("no LINE ID, address or picture in the file", () => {
  assert.deepEqual(src.match(/U[0-9a-f]{32}/g) || [], [])
  assert.deepEqual(src.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [], [])
  assert.equal(/insert into public\.dashboard_users[^;]*values \('U/.test(code), false)
})
