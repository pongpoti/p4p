/**
 * Department multipliers: process/sk03-formula.ts DEPT_CAPACITY must match
 * the "Departments and Multipliers" table in process/FORMULA.md (FTE and
 * doctors on staff from the staffing sheet), and each department's lack and
 * multiplier there must follow lack = max(0, 1 − on staff ÷ FTE) and
 * multiplier = 1 + LACK_K × lack (Pong, 2026-11-13: in proportion to lack,
 * no groups).
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
// | # | Department | Abbrev | FTE | On staff | Lack | Multiplier | Before |
const docRows = section
  .split("\n")
  .map((l) => l.split("|").map((c) => c.trim()))
  .filter((c) => /^\d+$/.test(c[1] ?? "") && /^[A-Z]{3}$/.test(c[3] ?? "") && c[3] !== "INT")
  .map((c) => ({
    no: Number(c[1]), name: c[2], code: c[3], fte: Number(c[4]), staff: Number(c[5]),
    lack: c[6], mult: c[7],
  }))
const byCode = (code) => f.DEPT_CAPACITY.find((d) => d.code === code)

test("FORMULA.md has the department table", () => {
  assert.ok(md.includes(heading), heading)
})

test("FORMULA.md lists the same 18 departments, in the same order", () => {
  assert.equal(docRows.length, 18)
  assert.deepEqual(docRows.map((r) => [r.no, r.name, r.code]), f.DEPT_CAPACITY.map((d) => [d.no, d.name, d.code]))
})

test("each department's FTE and doctors on staff in code equal FORMULA.md", () => {
  for (const r of docRows) {
    const d = byCode(r.code)
    assert.equal(d.fte, r.fte, `${r.code} FTE`)
    assert.equal(d.staff, r.staff, `${r.code} on staff`)
  }
})

test("FORMULA.md's lack and multiplier columns follow the code", () => {
  for (const r of docRows) {
    const d = byCode(r.code)
    const lack = f.deptLack(d)
    assert.equal(r.lack, lack === 0 ? "0%" : `${(100 * lack).toFixed(1)}%`, `${r.code} lack`)
    assert.equal(r.mult, f.deptMultiplier(d).toFixed(2), `${r.code} multiplier`)
  }
})

test("the multiplier is 1 + LACK_K × lack, lack 0 when fully or over-staffed", () => {
  assert.equal(f.LACK_K, 5)
  assert.ok(md.includes(`dept_mult_d = 1 + ${f.LACK_K} × lack_d`), "FORMULA.md states the same LACK_K")
  for (const d of f.DEPT_CAPACITY) {
    const lack = f.deptLack(d)
    assert.ok(lack >= 0 && lack < 1, d.code)
    assert.equal(lack, Math.max(0, 1 - d.staff / d.fte), d.code)
    assert.equal(f.deptMultiplier(d), 1 + f.LACK_K * lack, d.code)
    assert.ok(f.deptMultiplier(d) >= 1, `${d.code} is never below 1`)
  }
  // 13-11-69: SOC 4 of 10 (60% short), MED 37 of 47, PED 21 of 19 (over-staffed).
  assert.equal(f.deptMultiplier(byCode("SOC")), 4)
  assert.equal(f.deptMultiplier(byCode("ANS")), 3)
  assert.equal(f.deptMultiplier(byCode("MED")).toFixed(4), "2.0638")
  assert.equal(f.deptMultiplier(byCode("PED")), 1)
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

test("the งบรายสาขา sheet works out lack and the multiplier from FTE and on staff", () => {
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
  // The headers name what D and E hold.
  assert.match(f.BUDGET_HEADERS[3], /^ขาด/)
  assert.match(f.BUDGET_HEADERS[4], new RegExp(`^ตัวคูณสาขา\\n\\(1 \\+ ${f.LACK_K} × ขาด\\)$`))
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
