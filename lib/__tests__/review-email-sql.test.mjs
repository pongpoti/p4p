/**
 * scripts/review-email-2026-11.sql, read as text: it pastes through chat (no
 * backslash), keeps the tables and functions to the service role, queues an
 * email when a round is inserted and cancels it when the round is taken back,
 * and never carries the recipients (this repository is public: the settings
 * row is filled in the SQL editor).
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const src = readFileSync(resolve(root, "scripts/review-email-2026-11.sql"), "utf8")
const code = src.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")

test("pastes through chat: no backslash, no E'' string", () => {
  assert.equal(src.includes("\\"), false)
  assert.equal(/(^|[^a-z0-9_])e'/i.test(code), false)
})

test("service role only: RLS on both tables, every function revoked from the public roles", () => {
  assert.match(code, /array\['review_email_settings', 'review_emails'\]/)
  assert.match(code, /enable row level security/)
  assert.match(code, /revoke all on table public\.%I from anon, authenticated/)
  for (const fn of ["review_email_on_round", "review_email_on_withdraw", "review_email_queue", "claim_review_email"]) {
    assert.match(code, new RegExp("create or replace function public\\." + fn + "\\("), fn)
    assert.match(code, new RegExp("'" + fn + "'"), fn + " is in the revoke loop")
  }
  assert.match(code, /revoke all on function %s from public, anon, authenticated/)
  assert.match(code, /grant execute on function %s to service_role/)
  for (const fn of code.matchAll(/create or replace function public\.(\w+)/g)) {
    assert.match(code, /set search_path = ''/, fn[1])
  }
})

test("a round sent queues its email; a round taken back cancels one not sent", () => {
  assert.match(code, /create trigger review_email_on_round\s+after insert on public\.review_rounds/)
  assert.match(code, /create trigger review_email_on_withdraw\s+before delete on public\.review_rounds/)
  assert.match(code, /set status = 'cancelled'[^;]*where round_id = old\.id and status = 'queued'/)
  // An email already sent keeps its row when the round goes.
  assert.match(code, /round_id\s+bigint references public\.review_rounds\(id\) on delete set null/)
})

test("one email on its way per round, and the claim retakes a stale one", () => {
  assert.match(code, /create unique index if not exists review_emails_one_open\s+on public\.review_emails \(round_id\) where status in \('queued', 'sending'\)/)
  assert.match(code, /for update skip locked limit 1/)
  assert.match(code, /status = 'sending' and claimed_at < now\(\) - interval '15 minutes'/)
  assert.match(code, /coalesce\(next_try_at, created_at\) <= now\(\)/)
})

test("no recipients in the file: the settings row is filled in the SQL editor", () => {
  assert.equal(/insert into public\.review_email_settings/i.test(code), false)
  const addresses = src.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []
  assert.deepEqual(addresses, [])
})
