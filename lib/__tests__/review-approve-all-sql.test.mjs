/**
 * scripts/review-approve-all-2026-11.sql, read as text: it pastes through
 * chat (no backslash), stays with the service role, takes the round lock
 * like every other decision, refuses while anyone still to check has a check
 * that is not ตรงกัน, and changes only the people still to check.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const src = readFileSync(resolve(root, "scripts/review-approve-all-2026-11.sql"), "utf8")
const code = src.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")

test("pastes through chat: no backslash, no E'' string", () => {
  assert.equal(src.includes("\\"), false)
  assert.equal(/(^|[^a-z0-9_])e'/i.test(code), false)
})

test("service role only, fixed search_path", () => {
  assert.match(code, /create or replace function public\.review_approve_all\(p_month text, p_round int, p_actor text\)/)
  assert.match(code, /set search_path = ''/)
  assert.match(code, /p\.proname in \('review_approve_all'\)/)
  assert.match(code, /revoke all on function %s from public, anon, authenticated/)
  assert.match(code, /grant execute on function %s to service_role/)
})

test("the auditor's live round, the one on screen, locked", () => {
  assert.match(code, /r := public\.review_live_round\(p_month, 'submitted'\)/)
  assert.match(code, /if r\.round_no is distinct from p_round then raise exception 'review: another round'/)
})

test("refused while anyone still to check is not ตรงกัน on both checks, or has no checks", () => {
  assert.match(code, /left join public\.review_build_people p on p\.build_id = r\.build_id and p\.roster_index = d\.roster_index/)
  assert.match(code, /d\.decision is null\s+and \(p\.roster_index is null or p\.score_check <> 'match' or p\.money_check <> 'match'\)/)
  assert.match(code, /raise exception 'review: a check is not a match'/)
})

test("only the people still to check are approved; decided ones keep their result", () => {
  const upd = code.slice(code.indexOf("update public.review_decisions"))
  assert.match(upd, /set decision = 'approve', remark = '', carried = false,/)
  assert.match(upd, /where round_id = r\.id and decision is null;/)
  assert.match(code, /raise exception 'review: nobody to approve'/)
})
