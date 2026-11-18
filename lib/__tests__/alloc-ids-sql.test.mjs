/**
 * scripts/alloc-ids-2026-11.sql (step 29), read as text: it pastes through
 * chat, makes the two tables with their checks, keeps them and both
 * functions to the service role, and an upload keeps the digits typed on
 * the page for people the new file does not have. (Run against a local
 * PostgreSQL 16 when written, 2026-11-18.)
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const src = readFileSync(resolve(root, "scripts/alloc-ids-2026-11.sql"), "utf8")
const code = src.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
const fnBody = (name) => {
  const f = code.slice(code.indexOf("create or replace function public." + name + "("))
  return f.slice(0, f.indexOf("$$;"))
}

test("pastes through chat: no backslash, no E'' string, under 12 KB", () => {
  assert.equal(src.includes("\\"), false)
  assert.equal(/(^|[^a-z0-9_])e'/i.test(code), false)
  assert.ok(Buffer.byteLength(src) < 12 * 1024, Buffer.byteLength(src) + " bytes")
})

test("the tables: one row per doctor and month, 4 digits only, how it was found; one upload row per month", () => {
  const ids = code.slice(code.indexOf("create table if not exists public.alloc_ids"))
  const idsDef = ids.slice(0, ids.indexOf(");"))
  assert.match(idsDef, /no4\s+text not null check \(no4 ~ '\^\[0-9\]\{4\}\$'\)/)
  assert.match(idsDef, /how\s+text not null check \(how in \('exact', 'close', 'manual'\)\)/)
  assert.match(idsDef, /primary key \(month, roster_index\)/)
  assert.match(code, /create table if not exists public\.alloc_uploads \(\s+month\s+text primary key/)
  // Never the file itself, nor any ID card number: no column for them.
  assert.doesNotMatch(code, /\b(bytea|national|citizen|id_card)\b/i)
})

test("service role only: RLS on, nothing for anon or authenticated", () => {
  for (const t of ["alloc_ids", "alloc_uploads"]) {
    assert.ok(code.includes("alter table public." + t + " enable row level security;"), t)
    assert.ok(code.includes("revoke all on table public." + t + " from public, anon, authenticated;"), t)
    assert.ok(code.includes("grant select, insert, update, delete on table public." + t + " to service_role;"), t)
  }
  for (const sig of ["alloc_ids_save(text, jsonb, jsonb, text)", "alloc_id_set(text, uuid, text, text)"]) {
    assert.ok(code.includes("revoke all on function public." + sig + " from public, anon, authenticated;"), sig)
    assert.ok(code.includes("grant execute on function public." + sig + " to service_role;"), sig)
  }
  assert.equal((code.match(/\bgrant\b/gi) || []).length, 4)
})

test("alloc_ids_save: checks, the file's digits replaced, typed ones kept, still-missing names less those typed", () => {
  const b = fnBody("alloc_ids_save")
  assert.match(b, /set search_path = ''/)
  assert.match(b, /raise exception 'alloc: bad month'/)
  assert.match(b, /raise exception 'alloc: bad rows'/)
  assert.match(b, /delete from public\.alloc_ids where month = p_month and how <> 'manual';/)
  assert.match(b, /on conflict \(month, roster_index\) do update/)
  assert.equal((b.match(/where not exists \(select 1 from public\.alloc_ids a/g) || []).length, 2)
})

test("alloc_id_set: 4 digits, saved as typed, the person leaves the page's lists", () => {
  const b = fnBody("alloc_id_set")
  assert.match(b, /set search_path = ''/)
  assert.match(b, /if p_no4 is null or p_no4 !~ '\^\[0-9\]\{4\}\$' then raise exception 'alloc: bad digits'/)
  assert.match(b, /values \(p_month, p_index, p_no4, 'manual', now\(\), coalesce\(p_actor, ''\)\)/)
  assert.match(b, /missing = coalesce\(\(select jsonb_agg\(m\) from jsonb_array_elements\(missing\) m where m->>'index' <> p_index::text\)/)
  assert.match(b, /ambiguous = coalesce\(\(select jsonb_agg\(m\) from jsonb_array_elements\(ambiguous\) m where m->>'index' <> p_index::text\)/)
})
