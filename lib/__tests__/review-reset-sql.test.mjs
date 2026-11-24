/**
 * scripts/review-reset-2026-11.sql (step 31, รีเซ็ตเดือน), read as text: it
 * pastes through chat (no backslash), stays with the service role, takes the
 * month's round lock, refuses a month with no round or whose rounds are not
 * the ones the dialog showed, keeps a copy of everything before it deletes,
 * and that copy can only ever be added to.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const src = readFileSync(resolve(root, "scripts/review-reset-2026-11.sql"), "utf8")
const code = src.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
const body = code.slice(code.indexOf("create or replace function public.review_reset_month("), code.indexOf("do $$"))

test("pastes through chat: no backslash, no E'' string", () => {
  assert.equal(src.includes("\\"), false)
  assert.equal(/(^|[^a-z0-9_])e'/i.test(code), false)
})

test("service role only, fixed search_path, safe to re-run", () => {
  assert.match(code, /create table if not exists public\.review_resets/)
  assert.match(code, /create or replace function public\.review_reset_months\(p_months text\[\]\)/)
  assert.match(code, /create or replace function public\.review_reset_month\(p_month text, p_actor text, p_reason text, p_rounds int\)/)
  assert.equal(code.match(/set search_path = ''/g).length, 2)
  assert.match(code, /p\.proname in \('review_reset_months', 'review_reset_month'\)/)
  assert.match(code, /revoke all on function %s from public, anon, authenticated/)
  assert.match(code, /grant execute on function %s to service_role/)
})

test("the copy: RLS on, nobody else reads it, the service role can only add", () => {
  assert.match(code, /alter table public\.review_resets enable row level security/)
  assert.match(code, /revoke all on table public\.review_resets from public, anon, authenticated/)
  assert.match(code, /grant select, insert on table public\.review_resets to service_role/)
  assert.match(code, /revoke update, delete, truncate on table public\.review_resets from service_role/)
})

test("the month's lock, then the dialog's count, then nothing to reset", () => {
  assert.match(body, /perform pg_advisory_xact_lock\(hashtext\('review:' \|\| p_month\)\)/)
  assert.match(body, /if v_rounds = 0 then raise exception 'review: nothing to reset'/)
  assert.match(body, /if p_rounds is distinct from v_rounds then raise exception 'review: another round'/)
  assert.ok(body.indexOf("pg_advisory_xact_lock") < body.indexOf("'review: another round'"))
})

test("the copy is written before anything is deleted, with each round's decisions and the PDF path", () => {
  const ins = body.indexOf("insert into public.review_resets")
  assert.ok(ins > 0)
  assert.ok(ins < body.indexOf("update public.review_emails"))
  assert.ok(ins < body.indexOf("delete from public.review_issues"))
  assert.ok(ins < body.indexOf("delete from public.review_rounds"))
  // to_jsonb(r): the whole round row, pdf_path included.
  assert.match(body, /to_jsonb\(r\) \|\| jsonb_build_object\('decisions'/)
  assert.match(body, /to_jsonb\(i\) \|\| jsonb_build_object\('replies'/)
})

test("emails: waits for one going out now, cancels the rest; deletes only the month's rounds and problems", () => {
  assert.match(body, /perform 1 from public\.review_emails where month = p_month and status in \('queued', 'sending'\) for update/)
  assert.match(body, /claimed_at >= now\(\) - interval '15 minutes'\)/)
  assert.match(body, /raise exception 'review: an email is being sent'/)
  assert.match(body, /update public\.review_emails set status = 'cancelled', error = 'รีเซ็ตเดือน'\s+where month = p_month and status in \('queued', 'sending'\)/)
  assert.match(body, /delete from public\.review_issues where month = p_month;/)
  assert.match(body, /delete from public\.review_rounds where month = p_month;/)
  // The budget, the builds and the score edits stay.
  assert.equal(/review_inputs|review_builds|review_score/.test(body), false)
})
