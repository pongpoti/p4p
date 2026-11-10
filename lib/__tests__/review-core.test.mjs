/**
 * The ตรวจสอบ tab's shared rules (lib/review-core.ts): which cell is a
 * doctor's stated total, the two automatic checks, the W9 rate, per P4P
 * from budget and N, and which scores are out of range. The nightly build
 * and the Vercel app both use these, so a change here changes what the
 * auditor is shown.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const core = require(resolve(repoRoot, "lib/review-core"))
const p4p = require(resolve(repoRoot, "lib/p4p-score"))

test("cell names", () => {
  assert.equal(core.cellName(0, 0), "A1")
  assert.equal(core.cellName(14, 4), "E15")
  assert.equal(core.colName(25), "Z")
  assert.equal(core.colName(26), "AA")
  assert.equal(core.colName(36), "AK")
})

test("stated total: the grand-total row's saved value, with its cell", () => {
  const grid = [
    ["แบบบันทึก P4P", null, null, null, null],
    ["งาน", "แต้ม", "วัน 1", "วัน 2", "รวม"],
    ["ตรวจผู้ป่วยนอก", 2, 10, 12, 44],
    ["เวรบ่าย", 1.5, 3, 4, 10.5],
    ["รวมแต้มทั้งหมด", null, null, null, 54.5],
  ]
  assert.deepEqual(core.statedTotal(grid), { value: 54.5, cell: "E5", how: "grand-total" })
})

test("stated total: never recalculated, even when the doctor added it up wrong", () => {
  const grid = [
    ["งาน", "รวม"],
    ["ก", 100],
    ["ข", 200],
    ["รวมทั้งหมด", 250],
  ]
  assert.equal(core.statedTotal(grid).value, 250)
})

test("stated total: a total formula with no saved value is reported, not rebuilt", () => {
  const grid = [
    ["งาน", "รวม"],
    ["ก", 100],
    ["รวมทั้งหมด", null],
  ]
  assert.deepEqual(core.statedTotal(grid, new Set(["B3"])), { value: null, cell: null, how: "uncached" })
})

test("stated total: the number may sit inside the label text", () => {
  const grid = [["รวมแต้มทั้งหมด 3,260 แต้ม"]]
  assert.deepEqual(core.statedTotal(grid), { value: 3260, cell: "A1", how: "grand-total" })
})

test("stated total: years and dates are never a total", () => {
  const grid = [["รวมทั้งหมด", 2569, "2026-10-31", 1840]]
  assert.equal(core.statedTotal(grid).value, 1840)
})

test("stated total: sub-total rows when there is no grand-total row", () => {
  const grid = [["งาน", "แต้ม"], ["ก", 20], ["รวม", 30]]
  assert.deepEqual(core.statedTotal(grid), { value: 30, cell: "B3", how: "sub-total" })
  // A bigger number elsewhere in the sheet does not beat the labelled row:
  // the total is what the doctor wrote on it, not the sheet's largest number.
  const grid2 = [["งาน", "แต้ม"], ["ก", 900], ["รวม", 30]]
  assert.deepEqual(core.statedTotal(grid2), { value: 30, cell: "B3", how: "sub-total" })
})

// The score is the total on the LAST row, even when an earlier one is bigger.
test("stated total: the bottom-most total row, never the largest across rows", () => {
  // An earlier grand-total row (last month's, copied along) above this
  // month's real total.
  const grid = [
    ["งาน", "แต้ม"],
    ["รวมทั้งหมด (เดือนก่อน)", 2500],
    ["ก", 120],
    ["ข", 80],
    ["รวมทั้งหมด", 200],
  ]
  assert.deepEqual(core.statedTotal(grid), { value: 200, cell: "B5", how: "grand-total" })
  // Two sub-totals and a licence number elsewhere in the sheet: the stray
  // number is never the total.
  const sub = [
    ["เลขใบประกอบ", 34567],
    ["งาน", "แต้ม"],
    ["ก", 200],
    ["รวม", 200],
    ["ข", 300],
    ["รวม", 300],
  ]
  assert.deepEqual(core.statedTotal(sub), { value: 300, cell: "B6", how: "sub-total" })
  // A total typed as text: the last line, not the biggest.
  assert.deepEqual(core.statedTotal([["งาน", 5], ["รวม = 2500"], ["รวม = 200"]]), { value: 200, cell: "A3", how: "free-text" })
  // A bottom row with the label and no number does not hide the one above.
  assert.deepEqual(core.statedTotal([["รวมทั้งหมด", 1840], ["รวมทั้งหมด", null]]), { value: 1840, cell: "B1", how: "grand-total" })
})

test("stated total: nothing labelled means missing, never a guess", () => {
  assert.deepEqual(core.statedTotal([["งาน", 5], ["ข", 7]]), { value: null, cell: null, how: "none" })
})

// The rule that wrote the score in SK03 K (lib/p4p-score.ts
// extractScoreFromRows) reads these the same way; see the parity test below.
test("stated total: a real total in the year range is still the total", () => {
  const header = ["ประเภทงาน", "กิจกรรม", "แต้ม", "จำนวนรวม", "รวมแต้ม"]
  assert.deepEqual(core.statedTotal([header, ["OPD", "ตรวจ", 10, 120, 1200], ["IPD", "ราวด์", 20, 37, 740],
    ["รวมแต้มทั้งหมด", null, null, null, 1940]]), { value: 1940, cell: "E4", how: "grand-total" })
  assert.deepEqual(core.statedTotal([header, ["OPD", "ตรวจ", 10, 125, 1250], ["IPD", "ราวด์", 20, 60, 1200],
    ["รวมแต้มทั้งหมด", null, null, null, 2450]]), { value: 2450, cell: "E4", how: "grand-total" })
  // No score-column header: a year-like number counts when the row has no other.
  assert.deepEqual(core.statedTotal([["งาน", "แต้ม"], ["ก", 2000], ["รวมทั้งหมด", 2450]]),
    { value: 2450, cell: "B3", how: "grand-total" })
  // Inside the label cell, read without the year filter.
  assert.deepEqual(core.statedTotal([["รวมแต้มทั้งหมด 2,450 แต้ม"]]), { value: 2450, cell: "A1", how: "grand-total" })
})

test("stated total: the declared score column wins on a total row", () => {
  // Header names column C the total points: D's bigger number is not the total.
  const grid = [
    ["งาน", "จำนวน", "รวมแต้ม", "หมายเหตุ"],
    ["ตรวจผู้ป่วยนอก", 3000, 1500, "-"],
    ["เวร", 100, 810, "-"],
    ["รวมแต้มทั้งหมด", 3100, 2310, 9999],
  ]
  assert.deepEqual(core.statedTotal(grid), { value: 2310, cell: "C4", how: "grand-total" })
  // 'รวม | 74 | 1940': the count beside the total is not the total.
  const sub = [
    ["ประเภทงาน", "กิจกรรม", "แต้ม", "จำนวนรวม", "รวมแต้ม"],
    ["OPD", "ตรวจ", 10, 37, 370],
    ["IPD", "ราวด์", 20, 37, 1570],
    ["รวม", null, null, 74, 1940],
  ]
  assert.deepEqual(core.statedTotal(sub), { value: 1940, cell: "E4", how: "sub-total" })
})

test("stated total: a total typed as text", () => {
  const grid = [
    ["ประเภทงาน", "กิจกรรม", "แต้ม", "จำนวนรวม", "รวมแต้ม"],
    ["OPD", "ตรวจ", 10, 100, 1000],
    ["IPD", "ราวด์", 1320, 1, 1320],
    ["", "", "", "", "รวม =  3,260"],
  ]
  assert.deepEqual(core.statedTotal(grid), { value: 3260, cell: "E4", how: "free-text" })
  assert.deepEqual(core.statedTotal([["งาน", 5], [null, "คะแนนรวม: 1940.5"]]), { value: 1940.5, cell: "B2", how: "free-text" })
  assert.deepEqual(core.statedTotal([["งาน", 5], ["รวม 3260"]]), { value: 3260, cell: "A2", how: "free-text" })
})

test("stated total: labels match with spaces inside them", () => {
  assert.deepEqual(core.statedTotal([["งาน", "แต้ม"], ["ก", 1000], ["รวม แต้ม ทั้งหมด", 3000.5]]),
    { value: 3000.5, cell: "B3", how: "grand-total" })
  assert.deepEqual(core.statedTotal([["งาน", "แต้ม"], ["ก", 20], ["ผล รวม", 30]]), { value: 30, cell: "B3", how: "sub-total" })
})

test("stated total: uncached only when the total row has nothing else to read", () => {
  // Formula with no saved value, and nothing else on the row: never rebuilt
  // from the sub-totals or a text line elsewhere.
  const grid = [["งาน", "แต้ม"], ["รวม", 900], [null, "รวม = 900"], ["รวมทั้งหมด", null]]
  assert.deepEqual(core.statedTotal(grid, new Set(["B4"])), { value: null, cell: null, how: "uncached" })
  // Without the formula the row is just empty: the next pass reads the text.
  assert.deepEqual(core.statedTotal(grid), { value: 900, cell: "B3", how: "free-text" })
  // An uncached cell on a row that does hold a number: that number.
  assert.deepEqual(core.statedTotal([["รวมทั้งหมด", 1840, null]], new Set(["C1"])), { value: 1840, cell: "B1", how: "grand-total" })
  // An uncached sub-total row is not a grand-total row.
  assert.deepEqual(core.statedTotal([["งาน", "แต้ม"], ["ก", 20], ["รวม", 30], ["รวม", null]], new Set(["B4"])),
    { value: 30, cell: "B3", how: "sub-total" })
})

// Grid → the col_N rows the pipeline builds (automation/index.ts rowsOfSheet):
// one object per non-empty row, keys in column order, holes left out.
function toRows(grid) {
  const rows = []
  grid.forEach((row) => {
    if (!row) return
    const o = {}
    row.forEach((v, c) => { o["col_" + (c + 1)] = v })
    if (Object.keys(o).length) rows.push(o)
  })
  return rows
}

// A grid with holes, the way analyseDoctorFile builds one: [row, column, value].
function sparse(cells) {
  const grid = []
  for (const [r, c, v] of cells) (grid[r] ??= [])[c] = v
  return grid
}

const SAME_PASS = {
  "grand-total label row (all columns)": "grand-total",
  "free-text summary line": "free-text",
  "sub-total label row (col_1-3)": "sub-total",
}

function assertParity(grid, label) {
  const want = p4p.extractScoreFromRows(toRows(grid))
  const got = core.statedTotal(grid)
  if (SAME_PASS[want.method]) {
    assert.equal(got.value, want.score, label + ": " + want.method)
    assert.equal(got.how, SAME_PASS[want.method], label)
  } else {
    // The pipeline's guesses and recalculations are not a stated total.
    assert.deepEqual(got, { value: null, cell: null, how: "none" }, label + ": " + want.method)
  }
  return want.method
}

test("stated total: same number as the submission pipeline, pass by pass", () => {
  const H = ["ประเภทงาน", "กิจกรรม", "แต้ม", "จำนวนรวม", "รวมแต้ม"]
  const grids = {
    grand1940: [H, ["OPD", "ตรวจ", 10, 120, 1200], ["IPD", "ราวด์", 20, 37, 740], ["รวมแต้มทั้งหมด", null, null, null, 1940]],
    grandCount: [["งาน", "จำนวน"], ["ก", 37], ["รวมทั้งหมด", 74, 1940]],
    grandYearNote: [["งาน", "แต้ม"], ["ก", 900], ["รวมทั้งหมด", "ปี 2569", 2569, 1840]],
    grandLabelText: [["งาน", "แต้ม"], ["รวมทั้งหมด = 11,011.5", null]],
    twoGrandRows: [["รวมทั้งหมด", 1200], ["ก", 5], ["รวมทั้งสิ้น", 1300]],
    lastGrandSmaller: [["รวมทั้งหมด", 2500], ["ก", 120], ["รวมทั้งหมด", 200]],
    textSep: [H, ["OPD", "ตรวจ", 10, 100, 1000], ["", "", "", "", "รวม =  3260"]],
    textBare: [["งาน", "แต้ม"], ["ก", 5], ["รวม 2569"], ["ยอดรวม 812.5"]],
    textYear: [["งาน", "แต้ม"], ["ก", 5], ["รวม 2569"]],
    subDeclared: [H, ["OPD", "ตรวจ", 10, 37, 370], ["IPD", "ราวด์", 20, 37, 1570], ["รวม", null, null, 74, 1940]],
    subPlain: [["งาน", "แต้ม"], ["ก", 20], ["รวม", 30]],
    subYear: [["งาน", "จำนวน", "แต้ม"], ["ก", 37, 1000], ["ข", 37, 940], ["รวม", 74, 1940]],
    largestOverSub: [["งาน", "แต้ม"], ["ก", 900], ["รวม", 30]],
    strayOverSubs: [["เลขใบประกอบ", 34567], ["รวม", 200], ["รวม", 300]],
    subInThirdCol: [[null, null, "รวมคะแนน", 410], ["ก", 5]],
    headerOnlyLabel: [H, ["OPD", "ตรวจ", 10, 100, 1000]],
    nothing: [["งาน", 5], ["ข", 7]],
    yearsOnly: [["งาน", 2569], ["ข", 2450]],
    dates: [["รวมทั้งหมด", "2026-10-31T00:00:00.000Z", 1840]],
    sparse: sparse([[1, 0, "งาน"], [1, 2, "แต้ม"], [3, 3, "รวม แต้ม ทั้งหมด"], [3, 5, 515]]),
  }
  const seen = new Set()
  for (const [label, grid] of Object.entries(grids)) seen.add(assertParity(grid, label))
  for (const m of [...Object.keys(SAME_PASS), "largest in sheet", "largest in sheet (year-like fallback)"]) {
    assert.ok(seen.has(m), "no fixture reaches: " + m)
  }

  // And a few thousand sheets made of the same parts, mixed at random.
  const parts = [
    null, null, null, "", "งาน", "แต้ม", "จำนวน", "หมายเหตุ", "รวมแต้ม", "แต้มรวม", "รวม", "ผลรวม", "รวมคะแนน",
    "รวมแต้มทั้งหมด", "รวม แต้ม ทั้งหมด", "รวมทั้งสิ้น", "คะแนนรวมทั้งหมด", "รวม = 3260", "รวม 1,940", "คะแนนรวม: 2450",
    "รวมแต้มทั้งหมด 3,260 แต้ม", "รวม 2569", "ปี 2569", "2026-10-31", "15 แต้ม", "1,200",
    0, -5, 1, 2, 10, 37, 74, 120.5, 999, 1940, 2450, 2450.5, 2569, 3100, true,
  ]
  let seed = 20261108
  const rand = (n) => { // mulberry32
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n)
  }
  for (let i = 0; i < 3000; i++) {
    const grid = []
    const rows = 2 + rand(6), cols = 1 + rand(6)
    for (let r = 0; r < rows; r++) {
      if (rand(8) === 0) continue
      const row = []
      for (let c = 0; c < cols; c++) { const v = parts[rand(parts.length)]; if (v !== null || rand(2)) row[c] = v }
      grid[r] = row
    }
    assertParity(grid, "random sheet " + i + " " + JSON.stringify(grid))
  }
})

test("score and money checks", () => {
  assert.equal(core.scoreCheck(2310, 2310.001), "match")
  assert.equal(core.scoreCheck(2310, 2560), "mismatch")
  assert.equal(core.scoreCheck(2310, null), "missing")
  assert.equal(core.moneyCheck(10720, 10720), "match")
  assert.equal(core.moneyCheck(10720, 10270), "mismatch")
  assert.equal(core.moneyCheck(10720, undefined), "missing")
})

test("W9 rate", () => {
  assert.equal(core.w9Rate("=W10*9551.81"), 9551.81)
  assert.equal(core.w9Rate("= W10 * 9906"), 9906)
  assert.equal(core.w9Rate("=W10*0"), 0)
  assert.equal(core.w9Rate("=W10*A1"), null)
  assert.equal(core.w9Rate(229243.44), null)
})

test("per P4P = budget ÷ N, to the satang, half up", () => {
  assert.equal(core.perP4p(2158709.06, 226), 9551.81)
  assert.equal(core.perP4p(1000, 3), 333.33)
  assert.equal(core.perP4p(0.05, 2), 0.03)
  assert.equal(core.perP4p(2000, 3), 666.67)
})

test("N and score input", () => {
  assert.equal(core.parseCount("226", 1e5), 226)
  assert.equal(core.parseCount("1,226", 1e5), 1226)
  assert.equal(core.parseCount(226, 1e5), 226)
  for (const bad of ["0", "2.5", "-3", "abc", "", "100000", null, undefined]) assert.equal(core.parseCount(bad, 1e5), null, String(bad))
  assert.equal(core.parseScore("2,480.00"), 2480)
  assert.equal(core.parseScore("2480.5"), 2480.5)
  assert.equal(core.parseScore("0"), 0)
  for (const bad of ["2480.123", "-1", "abc", "", "1000000", null]) assert.equal(core.parseScore(bad), null, String(bad))
})

test("score alert: 30,000 or more, or under 2,200", () => {
  assert.equal(core.scoreFlag(30000), "high")
  assert.equal(core.scoreFlag(29999.99), null)
  assert.equal(core.scoreFlag(2200), null)
  assert.equal(core.scoreFlag(2199.99), "low")
  assert.equal(core.scoreFlag(0), "low")
  assert.equal(core.scoreFlag(null), null)
  assert.equal(core.SCORE_HIGH, 30000)
  assert.equal(core.SCORE_LOW, 2200)
})

test("month and money input", () => {
  assert.deepEqual(core.parseMonth("2569_10"), { be: 2569, month: 10 })
  assert.equal(core.parseMonth("2569_13"), null)
  assert.equal(core.parseMonth("2569-10"), null)
  assert.equal(core.parseMoney("2,158,709.06", 1e11), 2158709.06)
  assert.equal(core.parseMoney("9551.81", 1e7), 9551.81)
  assert.equal(core.parseMoney("9551.815", 1e7), null)
  assert.equal(core.parseMoney("0", 1e7), null)
  assert.equal(core.parseMoney("-5", 1e7), null)
  assert.equal(core.parseMoney("abc", 1e7), null)
})
