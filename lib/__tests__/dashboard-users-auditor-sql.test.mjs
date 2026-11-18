/**
 * scripts/dashboard-users-auditor-2026-11.sql (step 28), read as text: it
 * pastes through chat, lets dashboard_users and dashboard_perms_clean take
 * review.auditor, refuses a user with both ตรวจสอบ sides, keeps the function
 * to the service role, and writes no row.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const src = readFileSync(resolve(root, "scripts/dashboard-users-auditor-2026-11.sql"), "utf8")
const code = src.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
const KEYS = "array['followup.view','followup.edit','roster.view','staffing.view','review.auditee','review.auditor']::text[]"

test("pastes through chat: no backslash, no E'' string, under 12 KB", () => {
  assert.equal(src.includes("\\"), false)
  assert.equal(/(^|[^a-z0-9_])e'/i.test(code), false)
  assert.ok(Buffer.byteLength(src) < 12 * 1024, Buffer.byteLength(src) + " bytes")
})

test("the table check: the old one out by what it says, the new one takes review.auditor and refuses both sides", () => {
  assert.match(code, /pg_get_constraintdef\(oid\) like '%review\.auditee%'/)
  assert.match(code, /execute format\('alter table public\.dashboard_users drop constraint %I', c\.conname\)/)
  const add = code.slice(code.indexOf("add constraint dashboard_users_perms_check"))
  assert.ok(add.slice(0, add.indexOf(";")).includes("perms <@ " + KEYS))
  assert.match(add.slice(0, add.indexOf(";")), /not \(perms @> array\['review\.auditee','review\.auditor'\]::text\[\]\)/)
})

test("dashboard_perms_clean: the six keys, one side, fixed search path, service role only", () => {
  const fn = code.slice(code.indexOf("create or replace function public.dashboard_perms_clean("))
  const body = fn.slice(0, fn.indexOf("$$;"))
  assert.match(body, /set search_path = ''/)
  assert.ok(body.includes("if not (v <@ " + KEYS + ") then"))
  assert.match(body, /raise exception 'dashboard: bad perms'/)
  assert.match(body, /if v @> array\['review\.auditee','review\.auditor'\]::text\[\] then\s+raise exception 'dashboard: bad perms \(both review sides\)'/)
  assert.match(code, /revoke all on function public\.dashboard_perms_clean\(text\[\]\) from public, anon, authenticated;/)
  assert.match(code, /grant execute on function public\.dashboard_perms_clean\(text\[\]\) to service_role;/)
})

test("writes no row and grants nothing else", () => {
  assert.doesNotMatch(code, /\b(insert into|update public\.|delete from|truncate)\b/i)
  assert.equal((code.match(/\bgrant\b/gi) || []).length, 1)
})
