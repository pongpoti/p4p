/**
 * Department multipliers: process/sk03-formula.ts DEPT_CAPACITY must match
 * the "Departments and Multipliers" table in process/FORMULA.md (FTE, doctors
 * on staff, monthly and daily hires from the physician staffing sheet), and
 * each department's lack and multiplier there must follow
 * lack = max(0, 1 − on staff ÷ FTE) and multiplier = 1 + LACK_K × lack
 * (Pong, 2026-11-13: in proportion to lack, no groups; 2026-11-28: "The
 * calculation now does not include อัตราจ้าง", so monthly and daily hires,
 * counted from 2026-11-16 to 2026-11-27, are listed but not in lack).
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { readFileSync } from "node:fs"

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const f = require(resolve(repoRoot, "process/sk03-formula"))

const md = readFileSync(resolve(repoRoot, "process/FORMULA.md"), "utf8")
const heading = "## Departments and Multipliers"
const section = md.slice(md.indexOf(heading))
// | # | Department | Abbrev | FTE | On staff | Monthly | Daily | Lack | Multiplier | Before |
const docRows = section
  .split("\n")
  .map((l) => l.split("|").map((c) => c.trim()))
  .filter((c) => /^\d+$/.test(c[1] ?? "") && /^[A-Z]{3}$/.test(c[3] ?? "") && c[3] !== "INT")
  .map((c) => ({
    no: Number(c[1]), name: c[2], code: c[3], fte: Number(c[4]), staff: Number(c[5]),
    monthly: Number(c[6]), daily: Number(c[7]), lack: c[8], mult: c[9], before: c[10],
  }))
const byCode = (code) => f.DEPT_CAPACITY.find((d) => d.code === code)

test("FORMULA.md has the department table", () => {
  assert.ok(md.includes(heading), heading)
})

test("FORMULA.md lists the same 18 departments, in the same order", () => {
  assert.equal(docRows.length, 18)
  assert.deepEqual(docRows.map((r) => [r.no, r.name, r.code]), f.DEPT_CAPACITY.map((d) => [d.no, d.name, d.code]))
})

test("each department's FTE, doctors on staff, monthly and daily hires in code equal FORMULA.md", () => {
  for (const r of docRows) {
    const d = byCode(r.code)
    assert.equal(d.fte, r.fte, `${r.code} FTE`)
    assert.equal(d.staff, r.staff, `${r.code} on staff`)
    assert.ok(Number.isInteger(r.monthly) && r.monthly >= 0, `${r.code} monthly is a count`)
    assert.equal(d.monthly, r.monthly, `${r.code} monthly hires`)
    assert.ok(Number.isInteger(r.daily) && r.daily >= 0, `${r.code} daily is a count`)
    assert.equal(d.daily, r.daily, `${r.code} daily hires`)
  }
  // 25-11-69 report: 182 on staff, 1 monthly and 37 daily hires, 220 at work.
  assert.equal(f.DEPT_CAPACITY.reduce((n, d) => n + d.monthly, 0), 1)
  assert.equal(f.DEPT_CAPACITY.reduce((n, d) => n + d.daily, 0), 37)
  assert.equal(f.DEPT_CAPACITY.reduce((n, d) => n + d.staff + d.monthly + d.daily, 0), 220)
})

test("FORMULA.md's lack and multiplier columns follow the code", () => {
  for (const r of docRows) {
    const d = byCode(r.code)
    const lack = f.deptLack(d)
    assert.equal(r.lack, lack === 0 ? "0%" : `${(100 * lack).toFixed(1)}%`, `${r.code} lack`)
    assert.equal(r.mult, f.deptMultiplier(d).toFixed(2), `${r.code} multiplier`)
  }
})

test("FORMULA.md's Before 2026-11-28 column is the multiplier with the hires counted", () => {
  for (const r of docRows) {
    const d = byCode(r.code)
    const old = 1 + f.LACK_K * Math.max(0, 1 - (d.staff + d.monthly + d.daily) / d.fte)
    assert.equal(r.before, old.toFixed(2), `${r.code} before`)
  }
  // Leaving the hires out changes the seven departments that had hires and are short without them.
  const changed = docRows.filter((r) => r.before !== r.mult).map((r) => r.code)
  assert.deepEqual(changed, ["EYE", "OPD", "RAD", "SOC", "SUR", "OBG", "MED"])
})

test("every lack formula in FORMULA.md counts doctors on staff only", () => {
  const lines = md.split("\n").filter((l) => /lack_d\s+=/.test(l))
  assert.ok(lines.length >= 3, "the formula is stated in the summary, Step 3.2 and the department section")
  for (const l of lines) {
    assert.ok(l.includes("max(0, 1 − on_staff_d / FTE_d)"), l.trim())
    assert.ok(!/monthly_d|daily_d/.test(l), l.trim())
  }
})

test("the multiplier is 1 + LACK_K × lack, hires not counted, lack 0 when fully or over-staffed", () => {
  assert.equal(f.LACK_K, 5)
  assert.ok(md.includes(`dept_mult_d = 1 + ${f.LACK_K} × lack_d`), "FORMULA.md states the same LACK_K")
  for (const d of f.DEPT_CAPACITY) {
    const lack = f.deptLack(d)
    assert.ok(lack >= 0 && lack < 1, d.code)
    assert.equal(lack, Math.max(0, 1 - d.staff / d.fte), d.code)
    assert.equal(lack, f.deptLack({ ...d, monthly: d.monthly + 9, daily: d.daily + 9 }), `${d.code}: hires change nothing`)
    assert.equal(f.deptMultiplier(d), 1 + f.LACK_K * lack, d.code)
    assert.ok(f.deptMultiplier(d) >= 1, `${d.code} is never below 1`)
  }
  // 25-11-69, ข้าราชการ only: SOC 5 of 10, OPD 3 of 5, MED 33 of 47, ANS 7 of 15, PED 19 of 19, PAT 3 of 2 (over-staffed).
  assert.equal(f.deptMultiplier(byCode("SOC")), 3.5)
  assert.equal(f.deptMultiplier(byCode("OPD")).toFixed(4), "3.0000")
  assert.equal(f.deptMultiplier(byCode("ANS")).toFixed(4), "3.6667")
  assert.equal(f.deptMultiplier(byCode("MED")).toFixed(4), "2.4894")
  assert.equal(f.deptMultiplier(byCode("EYE")).toFixed(4), "2.6667")
  assert.equal(f.deptMultiplier(byCode("OBG")).toFixed(4), "2.3889")
  assert.equal(f.deptMultiplier(byCode("SUR")).toFixed(4), "1.7692")
  assert.equal(f.deptMultiplier(byCode("RAD")).toFixed(4), "1.6667")
  assert.equal(f.deptMultiplier(byCode("PED")), 1)
  assert.equal(f.deptMultiplier(byCode("PSY")), 1)
  assert.equal(f.deptMultiplier(byCode("PAT")), 1)
  assert.equal(f.deptMultiplier(byCode("EMR")), 1)
})

test("more lack always means a higher multiplier, in proportion", () => {
  const ds = [...f.DEPT_CAPACITY].sort((a, b) => f.deptLack(a) - f.deptLack(b))
  for (let k = 1; k < ds.length; k++) {
    const [a, b] = [ds[k - 1], ds[k]]
    if (f.deptLack(b) > f.deptLack(a)) assert.ok(f.deptMultiplier(b) > f.deptMultiplier(a), `${b.code} > ${a.code}`)
  }
  for (const d of f.DEPT_CAPACITY) {
    if (f.deptLack(d) > 0) assert.ok(Math.abs((f.deptMultiplier(d) - 1) / f.deptLack(d) - f.LACK_K) < 1e-12, d.code)
  }
})

test("the งบรายสาขา sheet works out lack and the multiplier from FTE and on staff (no hires)", () => {
  const cells = f.budgetSheet("staff", 8, 200, "label")
  const body = cells.find((c) => c.range === `A${f.BUDGET_FIRST}:Q${f.BUDGET_LAST}`)
  assert.equal(body.values.length, f.DEPT_CAPACITY.length)
  body.values.forEach((row, k) => {
    const r = f.BUDGET_FIRST + k
    const d = byCode(row[2])
    assert.equal(row[3], `=MAX(0,1-${d.staff}/${d.fte})`, `${d.code} D`)
    assert.equal(row[4], `=1+${f.LACK_K}*D${r}`, `${d.code} E`)
    assert.equal(row[7], `=F${r}*E${r}`, `${d.code} H units`)
  })
  // The headers and the A3 note name what D and E hold: ข้าราชการ only (Pong,
  // 2026-11-28); D is ขาดแคลน (Pong, 2026-11-17).
  assert.equal(f.BUDGET_HEADERS[3], "ขาดแคลน\n(1 − ข้าราชการ ÷ FTE)")
  const note = cells.find((c) => c.range === "A3").values[0][0]
  assert.ok(note.includes("ขาดแคลน = 1 − ข้าราชการที่ปฏิบัติงานจริง ÷ FTE (ไม่นับอัตราจ้าง"), "A3 note counts ข้าราชการ only")
  assert.ok(note.startsWith(`ตัวคูณสาขา = 1 + ${f.LACK_K} × ขาดแคลน,`), "A3 note says ขาดแคลน")
  assert.ok(note.includes("อัตรากำลัง 25-11-69"), "A3 note names the starting numbers by default")
  assert.match(f.BUDGET_HEADERS[4], new RegExp(`^ตัวคูณสาขา\\n\\(1 \\+ ${f.LACK_K} × ขาดแคลน\\)$`))
})

test("nobody is paid above 15,000: the excess goes to the rest of the department", () => {
  assert.equal(f.PAY_CAP, 15000)
  assert.ok(md.includes("min(15,000, 10,000 + rate_d × mult_i)"), "FORMULA.md Step 3.6 states the cap")
  const first = 8, last = 200
  const cells = f.budgetSheet("staff", first, last, "label")
  assert.equal(f.BUDGET_HEADERS.length, 17, "A..Q")
  assert.ok(cells.some((c) => c.range === "A4:Q4"))
  const body = cells.find((c) => c.range === `A${f.BUDGET_FIRST}:Q${f.BUDGET_LAST}`)
  const codes = `'staff'!$Q$${first}:$Q$${last}`
  const mults = `'staff'!$U$${first}:$U$${last}`
  body.values.forEach((row, k) => {
    const r = f.BUDGET_FIRST + k
    assert.equal(row.length, 17)
    // O: what this department's doctors would get above 15,000 at the uncapped rate L
    assert.equal(row[14], `=SUMPRODUCT((${codes}=C${r})*(${mults}*L${r}+10000>15000)*(${mults}*L${r}+10000-15000))`)
    // P: Σ multipliers of its doctors at or under 15,000; Q: the rate after passing O to them
    assert.equal(row[15], `=SUMPRODUCT((${codes}=C${r})*(${mults}*L${r}+10000<=15000)*${mults})`)
    assert.equal(row[16], `=IF(P${r}=0,L${r},L${r}+O${r}/P${r})`)
  })
  const total = cells.find((c) => c.range === `A${f.BUDGET_TOTAL}:Q${f.BUDGET_TOTAL}`)
  assert.equal(total.values[0][14], `=SUM(O${f.BUDGET_FIRST}:O${f.BUDGET_LAST})`)
  // Staff pay reads the capped rate (งบรายสาขา Q, the 15th column from C) and never passes 15,000.
  const row = f.staffRowCells(20, "SOC", first, last)
  assert.equal(row.N, "=IF(L20<0,0,ROUNDDOWN(IF($Y$14<0,$Y$10/$Y$11,MIN(15000,10000+U20*V20)),0))")
  assert.equal(row.QtoV[5], `=VLOOKUP(Q20,'งบรายสาขา'!$C$${f.BUDGET_FIRST}:$Q$${f.BUDGET_LAST},15,FALSE)`)
})

test("the งบรายสาขา sheet uses the staffing numbers it is given (the dashboard's อัตรากำลัง tab)", () => {
  const edited = f.DEPT_CAPACITY.map((d) => (d.code === "SOC" ? { ...d, staff: 2, daily: 3 } : d))
  const cells = f.budgetSheet("staff", 8, 200, "label", edited, "อัตรากำลัง 25-11-69 แก้ไขในแดชบอร์ดล่าสุด 26 พ.ย. 2569")
  const body = cells.find((c) => c.range === `A${f.BUDGET_FIRST}:Q${f.BUDGET_LAST}`)
  const soc = body.values.find((row) => row[2] === "SOC")
  assert.equal(soc[3], "=MAX(0,1-2/10)")
  const med = body.values.find((row) => row[2] === "MED")
  assert.equal(med[3], "=MAX(0,1-33/47)", "the other departments keep theirs")
  assert.ok(cells.find((c) => c.range === "A3").values[0][0].includes("แก้ไขในแดชบอร์ดล่าสุด 26 พ.ย. 2569"))
  // Only the 18 departments, in the fixed order.
  assert.throws(() => f.budgetSheet("staff", 8, 200, "label", edited.slice(1)), /18 departments/)
  assert.throws(() => f.budgetSheet("staff", 8, 200, "label", [...edited].reverse()), /order/)
})
