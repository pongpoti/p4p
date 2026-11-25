/**
 * lib/dept-staffing.ts, the staffing numbers shared by the SK03 build and
 * the dashboard's อัตรากำลัง tab, and scripts/dept-staffing-2026-11.sql,
 * which keeps them in Supabase: the SQL seeds the same 18 departments with
 * the same numbers, takes the same limits, has no backslash (it is pasted
 * through chat), lets only the service role in, and has a changed save
 * queue a build of the ตรวจสอบ months still with the auditee. Whole numbers
 * only; stored rows are laid over the starting numbers in the fixed order.
 * Monthly hires (2026-11-17) have their own column; a table from before it
 * reads with monthly 0 and is moved over by re-running the SQL.
 * ไม่ได้ปฏิบัติงาน (absent, 2026-11-26) is shown only: not in the multiplier,
 * filled by scripts/dept-staffing-absent-2026-11.sql (step 33), whose
 * staffing_save is the same as the base file's.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { readFileSync } from "node:fs"

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const s = require(resolve(repoRoot, "lib/dept-staffing"))
const f = require(resolve(repoRoot, "process/sk03-formula"))
const sql = readFileSync(resolve(repoRoot, "scripts/dept-staffing-2026-11.sql"), "utf8")
const sql33 = readFileSync(resolve(repoRoot, "scripts/dept-staffing-absent-2026-11.sql"), "utf8")
const codes = s.DEPT_STAFFING_DEFAULTS.map((d) => d.code)

test("the SK03 build and the dashboard share one list", () => {
  assert.equal(f.DEPT_CAPACITY, s.DEPT_STAFFING_DEFAULTS)
  assert.equal(f.LACK_K, s.LACK_K)
  assert.equal(s.DEPT_STAFFING_DEFAULTS.length, 18)
  assert.deepEqual(s.DEPT_STAFFING_DEFAULTS.map((d) => d.no), Array.from({ length: 18 }, (_, k) => k + 1))
  assert.equal(new Set(codes).size, 18)
  // FTE 13-11-69: 234 (the sheet's 235 includes แผนไทย). 25-11-69: 220 at
  // work, 182 on staff, 1 monthly hire (EYE), 37 daily.
  const sum = (k) => s.DEPT_STAFFING_DEFAULTS.reduce((n, d) => n + d[k], 0)
  assert.deepEqual([sum("fte"), sum("staff"), sum("monthly"), sum("daily")], [234, 182, 1, 37])
  assert.deepEqual(s.DEPT_STAFFING_DEFAULTS.filter((d) => d.monthly).map((d) => [d.code, d.staff, d.monthly]), [["EYE", 6, 1]])
  // ไม่ได้ปฏิบัติงาน in the 25-11-69 report: 13 (OPD's are left out there).
  assert.equal(sum("absent"), 13)
  assert.deepEqual(s.DEPT_STAFFING_DEFAULTS.filter((d) => d.absent).map((d) => [d.code, d.absent]),
    [["PED", 3], ["EYE", 1], ["RAD", 1], ["ANS", 2], ["SUR", 1], ["ORT", 1], ["MED", 4]])
  assert.equal(s.STAFFING_SOURCE, "อัตรากำลัง 25-11-69")
  // The อัตรากำลัง tab reads "ปรับปรุงข้อมูล วันที่" from the date at its end.
  assert.match(s.STAFFING_SOURCE, /(\d{1,2})-(\d{1,2})-(\d{2})\s*$/)
})

test("lack and multiplier", () => {
  assert.equal(s.deptLack({ fte: 10, staff: 4, monthly: 0, daily: 15 }), 0)
  assert.equal(s.deptLack({ fte: 15, staff: 9, monthly: 0, daily: 0 }), 0.4)
  assert.equal(s.deptMultiplier({ fte: 15, staff: 9, monthly: 0, daily: 0 }), 3)
  assert.equal(s.deptMultiplier({ fte: 15, staff: 7, monthly: 2, daily: 0 }), 3, "monthly hires count like staff")
  assert.equal(s.deptMultiplier({ fte: 4, staff: 0, monthly: 0, daily: 0 }), 1 + s.LACK_K)
  assert.equal(s.deptMultiplier({ fte: 5, staff: 5, monthly: 0, daily: 0 }), 1)
  assert.equal(s.deptMultiplier({ fte: 15, staff: 9, monthly: 0, daily: 0, absent: 6 }), 3, "absent is not in the multiplier")
  // Moving MED's and EYE's monthly hire out of staff changed no multiplier.
  for (const code of ["MED", "EYE"]) {
    const d = s.staffingDept(code)
    assert.equal(s.deptMultiplier(d), s.deptMultiplier({ ...d, staff: d.staff + d.monthly, monthly: 0 }), code)
  }
})

test("a count is a whole number within its field's limits", () => {
  for (const [v, field, want] of [
    [0, "staff", 0], [999, "daily", 999], ["08", "staff", 8], [" 12 ", "fte", 12], [1, "fte", 1], [0, "monthly", 0],
    ["3", "monthly", 3], [-1, "monthly", null], [1000, "monthly", null],
    [0, "fte", null], ["0", "fte", null], [1000, "staff", null], ["1000", "staff", null], [-1, "daily", null],
    ["-1", "daily", null], [1.5, "staff", null], ["1.5", "staff", null], ["", "staff", null], ["1e2", "staff", null],
    ["1,000", "fte", null], [null, "staff", null], [undefined, "staff", null], [true, "staff", null], [NaN, "fte", null],
    [Infinity, "fte", null], ["๑๒", "fte", null],
  ]) assert.equal(s.parseStaffCount(v, field), want, `${JSON.stringify(v)} as ${field}`)
})

test("saved rows are laid over the starting numbers, in the fixed order", () => {
  const out = s.mergeStaffing([
    { code: "MED", fte: 47, staff: 36, monthly: 1, daily: 6, updated_at: "2026-11-16T10:00:00+00:00", updated_by: "Pong" },
    { code: "SOC", fte: 0, staff: 4, monthly: 0, daily: 15 },          // FTE 0 is not allowed: starting numbers
    { code: "EYE", fte: 9, staff: 7, monthly: -1, daily: 0 },          // a bad monthly count too
    { code: "XYZ", fte: 1, staff: 1, monthly: 0, daily: 1 },           // not a department: left out
    { code: "ANS", fte: "15", staff: "10", monthly: "2", daily: "0" }, // numeric strings are fine
    null, "junk",
  ])
  assert.deepEqual(out.list.map((d) => d.code), codes)
  const med = out.list.find((d) => d.code === "MED")
  assert.deepEqual([med.fte, med.staff, med.monthly, med.daily, med.updated_by], [47, 36, 1, 6, "Pong"])
  assert.equal(med.updated_at, "2026-11-16T10:00:00+00:00")
  const soc = out.list.find((d) => d.code === "SOC")
  assert.deepEqual([soc.fte, soc.staff, soc.monthly, soc.daily, soc.updated_at], [10, 5, 0, 15, null])
  const eye = out.list.find((d) => d.code === "EYE")
  assert.deepEqual([eye.staff, eye.monthly], [6, 1], "EYE keeps its starting numbers")
  const ans = out.list.find((d) => d.code === "ANS")
  assert.deepEqual([ans.staff, ans.monthly], [10, 2])
  assert.deepEqual(out.bad, ["EYE", "SOC"])
  assert.deepEqual(out.unknown, ["XYZ"])
  assert.deepEqual(out.noMonthly, [])
  assert.equal(out.missing.length, 14)
  assert.ok(!["MED", "SOC", "EYE", "ANS"].some((c) => out.missing.includes(c)))
  // No table or a broken answer: all starting numbers.
  for (const rows of [undefined, null, {}, "x"]) {
    const o = s.mergeStaffing(rows)
    assert.deepEqual(o.list.map(({ no, name, code, fte, staff, monthly, daily, absent }) => ({ no, name, code, fte, staff, monthly, daily, absent })),
      s.DEPT_STAFFING_DEFAULTS)
    assert.ok(o.list.every((d) => d.updated_at === null && d.updated_by === null))
    assert.equal(o.missing.length, 18)
  }
})

test("a table from before the monthly column reads with monthly 0 and the same multiplier", () => {
  // As the 2026-11-16 SQL seeded it: staff is รวมอัตราตามจริง, monthly hires included.
  const old = s.DEPT_STAFFING_DEFAULTS.map(({ code, fte, staff, monthly, daily }) => ({ code, fte, staff: staff + monthly, daily }))
  const out = s.mergeStaffing(old)
  assert.deepEqual(out.noMonthly, codes)
  assert.deepEqual([out.missing, out.bad, out.unknown], [[], [], []])
  const med = out.list.find((d) => d.code === "MED")
  assert.deepEqual([med.staff, med.monthly, med.daily], [33, 0, 4])
  const eye = out.list.find((d) => d.code === "EYE")
  assert.deepEqual([eye.staff, eye.monthly, eye.daily], [7, 0, 0])
  for (const d of out.list) assert.equal(s.deptMultiplier(d), s.deptMultiplier(s.staffingDept(d.code)), d.code)
  // A row with monthly null is a bad row, not an old one.
  const nul = s.mergeStaffing([{ code: "MED", fte: 47, staff: 37, monthly: null, daily: 4 }])
  assert.deepEqual([nul.bad, nul.noMonthly], [["MED"], []])
})

test("a table from before the absent column reads with the starting absent; a bad absent is 0", () => {
  const old = s.DEPT_STAFFING_DEFAULTS.map(({ code, fte, staff, monthly, daily }) => ({ code, fte, staff, monthly, daily }))
  const out = s.mergeStaffing(old)
  assert.deepEqual(out.noAbsent, codes)
  assert.deepEqual([out.missing, out.bad, out.unknown, out.noMonthly], [[], [], [], []])
  assert.deepEqual(out.list.map((d) => d.absent), s.DEPT_STAFFING_DEFAULTS.map((d) => d.absent))
  // Saved numbers win; one out of range is 0 and leaves the multiplier's numbers in use.
  const saved = s.mergeStaffing([{ code: "MED", fte: 47, staff: 30, monthly: 0, daily: 4, absent: 7 },
    { code: "SUR", fte: 39, staff: 30, monthly: 0, daily: 1, absent: -1 }, { code: "ORT", fte: 17, staff: 15, monthly: 0, daily: 0, absent: null }])
  const by = (c) => saved.list.find((d) => d.code === c)
  assert.deepEqual([by("MED").absent, by("MED").staff, by("SUR").absent, by("SUR").staff, by("ORT").absent], [7, 30, 0, 30, 0])
  assert.deepEqual([saved.bad, saved.noAbsent], [[], []])
})

test("staffingDept finds a department by code only", () => {
  assert.equal(s.staffingDept("PED").name, "กุมารเวชกรรม")
  for (const c of ["ped", "", "INT", null, undefined, "__proto__", "constructor"]) assert.equal(s.staffingDept(c), null, String(c))
})

test("the SQL seeds the same 18 departments with the same numbers", () => {
  const seed = [...sql.matchAll(/\('([A-Z]{3})',\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\)/g)].map((m) => ({
    code: m[1], fte: Number(m[2]), staff: Number(m[3]), monthly: Number(m[4]), daily: Number(m[5]), absent: Number(m[6]),
  }))
  assert.deepEqual(seed, s.DEPT_STAFFING_DEFAULTS.map(({ code, fte, staff, monthly, daily, absent }) => ({ code, fte, staff, monthly, daily, absent })))
  assert.match(sql, /insert into public\.dept_staffing \(code, fte, staff, monthly, daily, absent\)/)
  assert.match(sql, /on conflict \(code\) do nothing;/, "re-running never overwrites a saved number")
  // Both code lists (the table's check and staffing_save's) are the 18 codes.
  const lists = [...sql.matchAll(/code in \(([^)]*)\)|p_code not in \(([^)]*)\)/g)].map((m) => (m[1] || m[2]).match(/[A-Z]{3}/g))
  assert.equal(lists.length, 2)
  for (const l of lists) assert.deepEqual(l, codes)
})

test("the SQL takes the same limits as the app", () => {
  const L = s.STAFFING_LIMITS
  for (const k of ["fte", "staff", "monthly", "daily"]) {
    assert.ok(sql.includes(`check (${k} between ${L[k].min} and ${L[k].max})`), `table check on ${k}`)
    assert.ok(sql.includes(`p_${k} is null or p_${k} < ${L[k].min} or p_${k} > ${L[k].max}`), `staffing_save check on ${k}`)
  }
  for (const q of [sql, sql33]) {
    assert.ok(q.includes(`check (absent between ${L.absent.min} and ${L.absent.max})`), "table check on absent")
    assert.ok(q.includes(`p_absent is not null and (p_absent < ${L.absent.min} or p_absent > ${L.absent.max})`), "staffing_save check on absent")
  }
})

test("step 33 fills ไม่ได้ปฏิบัติงาน once, and its staffing_save is the base file's", () => {
  const up = sql33.slice(sql33.indexOf("update public.dept_staffing t"), sql33.indexOf("-- 2."))
  const fill = [...up.matchAll(/\('([A-Z]{3})', (\d+)\)/g)].map((m) => [m[1], Number(m[2])])
  assert.deepEqual(fill, s.DEPT_STAFFING_DEFAULTS.filter((d) => d.absent).map((d) => [d.code, d.absent]))
  assert.match(up, /and not exists \(select 1 from public\.dept_staffing x where x\.absent > 0\);/, "never over an edit")
  const fn = (q) => q.slice(q.indexOf("drop function if exists public.staffing_save(text, int, int, int, text);"),
    q.indexOf("grant execute on function public.staffing_save"))
  assert.ok(fn(sql33).length > 1000)
  assert.equal(fn(sql), fn(sql33))
  // The 6-argument calls (the app before, step 32's file) still reach it.
  assert.match(sql33, /p_actor text, p_absent int default null\)/)
  assert.match(sql33, /drop function if exists public\.staffing_save\(text, int, int, int, int, text\);/)
  assert.match(sql33, /absent = coalesce\(p_absent, t\.absent\)/)
  assert.ok(!sql33.includes("\\"), "no backslash")
  assert.ok(Buffer.byteLength(sql33) < 12000, `${Buffer.byteLength(sql33)} bytes`)
  assert.match(sql33, /revoke all on function public\.staffing_save\(text, int, int, int, int, text, int\) from public, anon, authenticated;/)
  assert.match(sql33, /grant execute on function public\.staffing_save\(text, int, int, int, int, text, int\) to service_role;/)
})

test("a changed save queues a build of each ตรวจสอบ month still with the auditee", () => {
  const fn = sql.slice(sql.indexOf("create or replace function public.staffing_save"))
  const { REVIEW_FIRST_MONTH } = require(resolve(repoRoot, "process/review-build"))
  // Only when a number changed, and only once the ตรวจสอบ tables are there.
  // ไม่ได้ปฏิบัติงาน is not one of them: a change to it alone rebuilds nothing.
  assert.match(fn, /\(v_before\.fte, v_before\.staff, v_before\.monthly, v_before\.daily\)\s+is distinct from \(v_after\.fte, v_after\.staff, v_after\.monthly, v_after\.daily\)/)
  assert.match(fn, /to_regclass\('public\.review_builds'\) is not null and to_regclass\('public\.review_rounds'\) is not null/)
  assert.match(fn, /to_regprocedure\('public\.review_request_build\(text, text, text\)'\) is not null/)
  // The months the tab shows, each under the lock a send takes, skipped
  // once a round is with the auditor or approved (review_auditee_turn).
  assert.ok(fn.includes(`b.month >= '${REVIEW_FIRST_MONTH}'`), "from REVIEW_FIRST_MONTH")
  assert.match(fn, /pg_advisory_xact_lock\(hashtext\('review:' \|\| v_month\)\);\s+if not exists \(select 1 from public\.review_rounds r\s+where r\.month = v_month and r\.status in \('submitted', 'approved'\)\)/)
  assert.match(fn, /perform public\.review_request_build\(v_month, 'inputs', coalesce\(p_actor, ''\)\);/)
  assert.match(fn, /'rebuild', to_jsonb\(v_months\)\)/)
})

test("the SQL pastes through chat and lets only the service role in", () => {
  assert.ok(!sql.includes("\\"), "no backslash")
  assert.match(sql, /alter table public\.dept_staffing enable row level security;/)
  assert.match(sql, /revoke all on table public\.dept_staffing from public, anon, authenticated;/)
  assert.match(sql, /grant select, insert, update on table public\.dept_staffing to service_role;/)
  assert.match(sql, /revoke all on function public\.staffing_save\(text, int, int, int, int, text, int\) from public, anon, authenticated;/)
  assert.match(sql, /grant execute on function public\.staffing_save\(text, int, int, int, int, text, int\) to service_role;/)
  assert.match(sql, /set search_path = ''/)
  // Short enough to paste in one chat message part.
  assert.ok(Buffer.byteLength(sql) < 12000, `${Buffer.byteLength(sql)} bytes`)
})

test("re-running the SQL on a table from before the monthly column moves the monthly hires over", () => {
  const p1 = sql.slice(0, sql.indexOf("PART 2:"))
  // The column comes before the seed, which names it.
  const alter = p1.indexOf("add column if not exists monthly int not null default 0 check (monthly between 0 and 999);")
  assert.ok(alter > 0 && alter < p1.indexOf("insert into public.dept_staffing"), "alter, then seed")
  // Only MED and EYE, from their staff on the 13-11-69 sheet (37 = 36 + 1,
  // 8 = 7 + 1), and only rows still as on that sheet.
  const up = p1.slice(p1.indexOf("update public.dept_staffing t"), p1.indexOf("-- Check:"))
  const moves = [...up.matchAll(/\('([A-Z]{3})', (\d+), (\d+)\)/g)].map((m) => [m[1], Number(m[2]), Number(m[3])])
  assert.deepEqual(moves, [["EYE", 8, 1], ["MED", 37, 1]])
  assert.match(up, /set staff = t\.staff - m\.monthly, monthly = m\.monthly/)
  assert.match(up, /where t\.code = m\.code and t\.staff = m\.sheet_staff and t\.monthly = 0 and t\.updated_at is null;/)
  assert.ok(p1.indexOf("update public.dept_staffing t") > p1.indexOf("on conflict (code) do nothing;"), "after the seed")
  // The save without monthly hires is dropped, so the app cannot call it by mistake.
  assert.match(sql, /drop function if exists public\.staffing_save\(text, int, int, int, text\);/)
  assert.match(sql, /p_code text, p_fte int, p_staff int, p_monthly int, p_daily int,\s+p_actor text, p_absent int default null\)/)
})
