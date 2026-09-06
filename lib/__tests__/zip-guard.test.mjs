/**
 * The guard that stands between an untrusted .xlsx and ExcelJS.
 *
 * This matters more here than it does in automation/: on a GitHub runner a
 * hostile workbook costs a disposable container, but /upload/score opens the
 * same bytes inside the Vercel function that holds SUPABASE_SERVICE_ROLE_KEY
 * (design §11). The entry/size guard bounds memory, the parse timeout bounds
 * CPU, and neither is allowed to turn a merely-awkward file into a 500 — the
 * correct outcome for anything suspicious is "deferred to the worker", not
 * "request hangs".
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const score = require(resolve(repoRoot, "lib/p4p-score.js"))
const ExcelJS = require("exceljs")

/** A real, minimal P4P-shaped workbook. */
async function makeWorkbook(rows = [["รวมทั้งหมด", 1842.5]], sheetName = "มิถุนายน") {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet(sheetName)
  for (const row of rows) ws.addRow(row)
  return Buffer.from(await wb.xlsx.writeBuffer())
}

/**
 * Forge a zip central directory claiming `entries` files of `uncompressed`
 * bytes each. Nothing has to decompress for the guard to be exercised — the
 * declared sizes are what a zip bomb lies about, and what the guard reads.
 */
function forgeZip({ entries, uncompressed }) {
  const cd = []
  for (let i = 0; i < entries; i++) {
    const name = Buffer.from(`f${i}.xml`)
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt32LE(uncompressed, 20) // compressed size
    header.writeUInt32LE(uncompressed, 24) // uncompressed size
    header.writeUInt16LE(name.length, 28)
    cd.push(header, name)
  }
  const central = Buffer.concat(cd)

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries, 8)   // records on this disk
  eocd.writeUInt16LE(entries, 10)  // total records
  eocd.writeUInt32LE(central.length, 12)
  eocd.writeUInt32LE(0, 16)        // central directory starts at 0 here
  return Buffer.concat([central, eocd])
}

test("a genuine .xlsx passes the guard", async () => {
  const buffer = await makeWorkbook()
  const stats = score.checkZipSafety(buffer)
  assert.ok(stats.entryCount > 0, "should have counted the workbook's parts")
  assert.ok(stats.uncompressedBytes > 0)
})

test("too many entries is refused", () => {
  const buffer = forgeZip({ entries: 201, uncompressed: 10 })
  assert.throws(() => score.checkZipSafety(buffer), (err) => {
    assert.equal(err.code, "ZIP_TOO_MANY_ENTRIES")
    return true
  })
})

test("a declared uncompressed size over the cap is refused", () => {
  // 6 entries x 10 MB = 60 MB declared, against a 50 MB cap: the classic
  // small-file-huge-expansion shape.
  const buffer = forgeZip({ entries: 6, uncompressed: 10 * 1024 * 1024 })
  assert.throws(() => score.checkZipSafety(buffer), (err) => {
    assert.equal(err.code, "ZIP_TOO_LARGE")
    return true
  })
})

test("a ZIP64 entry is refused rather than parsed", () => {
  // 0xFFFFFFFF means "the real size is in the extra field". A 5 MB-capped
  // scorecard never needs ZIP64, so this is treated as suspicious.
  const buffer = forgeZip({ entries: 1, uncompressed: 0xffffffff })
  assert.throws(() => score.checkZipSafety(buffer), (err) => {
    assert.equal(err.code, "ZIP64_UNSUPPORTED")
    return true
  })
})

test("something that is not a zip at all is refused", () => {
  assert.throws(() => score.checkZipSafety(Buffer.from("this is a PDF, honest".repeat(20))), (err) => {
    assert.equal(err.code, "NOT_A_ZIP")
    return true
  })
})

test("a truncated central directory is refused", () => {
  const buffer = forgeZip({ entries: 4, uncompressed: 100 })
  // Claim 4 entries but only ship the bytes of two.
  const truncated = Buffer.concat([buffer.subarray(0, 60), buffer.subarray(buffer.length - 22)])
  assert.throws(() => score.checkZipSafety(truncated), (err) => {
    assert.ok(["ZIP_MALFORMED", "NOT_A_ZIP"].includes(err.code), `unexpected code ${err.code}`)
    return true
  })
})

test("the guard runs before the parser, not after", async () => {
  // parseWorkbookRowsSafely must refuse a hostile archive without ever
  // handing it to ExcelJS — the whole point of ordering them this way.
  const buffer = forgeZip({ entries: 400, uncompressed: 10 })
  await assert.rejects(() => score.parseWorkbookRowsSafely(buffer), (err) => {
    assert.equal(err.code, "ZIP_TOO_MANY_ENTRIES")
    return true
  })
})

test("a slow parse times out with a code the caller can branch on", async () => {
  const buffer = await makeWorkbook()
  // 0ms budget: the race is decided by the timer before any parse can finish.
  await assert.rejects(() => score.parseWorkbookRowsSafely(buffer, { timeoutMs: 1 }), (err) => {
    assert.equal(err.code, "PARSE_TIMEOUT", "the route defers on this code instead of failing the upload")
    return true
  })
})

test("rows come back in the col_N shape the extractor expects", async () => {
  const buffer = await makeWorkbook([
    ["ประเภทงาน", "กิจกรรม", "แต้ม"],
    ["บริการ", "ตรวจ OPD", 2],
    ["รวมทั้งหมด", null, 1842.5],
  ])
  const { rows, sheetName } = await score.parseWorkbookRowsSafely(buffer)
  assert.equal(sheetName, "มิถุนายน")
  assert.equal(rows.length, 3)
  assert.equal(rows[0].col_1, "ประเภทงาน")
  assert.deepEqual(score.resolveScore(rows), {
    score: 1842.5,
    method: "grand-total label row (all columns)",
  })
})

test("the right sheet is chosen in a multi-month workbook", async () => {
  const wb = new ExcelJS.Workbook()
  const may = wb.addWorksheet("พฤษภาคม")
  may.addRow(["รวมทั้งหมด", 100])
  may.addRow(["x", 1])
  may.addRow(["y", 2])
  const jun = wb.addWorksheet("มิถุนายน")
  jun.addRow(["รวมทั้งหมด", 900])
  jun.addRow(["x", 1])
  jun.addRow(["y", 2])
  const buffer = Buffer.from(await wb.xlsx.writeBuffer())

  // 6 = June: a physician who keeps every month in one file uploads the same
  // workbook each time, and the month they picked is what picks the sheet.
  const { sheetName, rows } = await score.parseWorkbookRowsSafely(buffer, { targetMonth: 6 })
  assert.equal(sheetName, "มิถุนายน")
  assert.equal(score.resolveScore(rows).score, 900)
})

/** Build a workbook from [tabName, [rows...]] pairs. */
async function makeSheets(...specs) {
  const wb = new ExcelJS.Workbook()
  for (const [name, rows] of specs) {
    const ws = wb.addWorksheet(name)
    for (const r of rows) ws.addRow(r)
  }
  return Buffer.from(await wb.xlsx.writeBuffer())
}

test("generic tab names: the sheet is chosen by the month stated in its content", async () => {
  // The real report this came from: tabs are "sheet1"/"sheet2" and only the
  // title row says which month each holds. Submitting July 2569 must reach
  // the กค69 sheet, not sheet 0 just because it is first.
  const buffer = await makeSheets(
    ["sheet1", [["รายงานผลงาน มค67"], ["ประเภทงาน", "แต้ม"], ["รวมทั้งหมด", 100]]],
    ["sheet2", [["รายงานผลงาน กค69"], ["ประเภทงาน", "แต้ม"], ["รวมทั้งหมด", 900]]],
  )
  const { sheetName, rows } = await score.parseWorkbookRowsSafely(buffer, { targetMonth: 7, targetYear: 2569 })
  assert.equal(sheetName, "sheet2")
  assert.equal(score.resolveScore(rows).score, 900)
})

test("generic tab names: the year picks between two sheets of the same month", async () => {
  const buffer = await makeSheets(
    ["sheet1", [["กค67"], ["ประเภทงาน", "แต้ม"], ["รวมทั้งหมด", 100]]],
    ["sheet2", [["กค69"], ["ประเภทงาน", "แต้ม"], ["รวมทั้งหมด", 900]]],
  )
  const { sheetName } = await score.parseWorkbookRowsSafely(buffer, { targetMonth: 7, targetYear: 2569 })
  assert.equal(sheetName, "sheet2")
})

test("a tab name that states the month still outranks another sheet's content", async () => {
  // Sheet 0's tab says June, so it is disqualified for a July submission
  // even though it sits first; sheet 1 wins on content.
  const buffer = await makeSheets(
    ["มิถุนายน", [["รวมทั้งหมด", 100], ["x", 1], ["y", 2]]],
    ["sheet2", [["กค69"], ["ประเภทงาน", "แต้ม"], ["รวมทั้งหมด", 900]]],
  )
  const { sheetName } = await score.parseWorkbookRowsSafely(buffer, { targetMonth: 7, targetYear: 2569 })
  assert.equal(sheetName, "sheet2")
})

test("a workbook with no sheet for the chosen month falls back rather than guessing a wrong one", async () => {
  // Nothing here is July: selection must not pick the มค sheet just because
  // it is the only one that says anything. It falls back to the positional
  // default, and the month_mismatch check downstream is what refuses it.
  const buffer = await makeSheets(
    ["sheet1", [["มค67"], ["ประเภทงาน", "แต้ม"], ["รวมทั้งหมด", 100]]],
    ["sheet2", [["มค67"], ["ประเภทงาน", "แต้ม"], ["รวมทั้งหมด", 200]]],
  )
  const { sheetName, rows } = await score.parseWorkbookRowsSafely(buffer, { targetMonth: 7, targetYear: 2569 })
  assert.equal(sheetName, "sheet1")
  assert.equal(score.resolveBeMonthFromRows(rows), 1, "the cross-check still sees January and will reject")
})

test("the dotted abbreviation — the form Thai documents actually use — resolves for every month", () => {
  const dotted = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
                  "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."]
  dotted.forEach((tok, i) => {
    assert.equal(score.monthFromCellText(tok), i + 1, `${tok} should be month ${i + 1}`)
  })
  // Whole date strings, which is how they actually appear in a title row.
  assert.deepEqual(score.monthYearFromText("31 ก.ค. 2569"), { month: 7, beYear: 2569 })
  assert.deepEqual(score.monthYearFromText("ประจำเดือน ก.ค. 69"), { month: 7, beYear: 2569 })
})

test("the ฏ/ฎ spelling and the undotted abbreviations all still resolve", () => {
  for (const tok of ["กรกฎาคม", "กรกฏา", "กค", "ก.ค.", "กค."]) {
    assert.equal(score.monthFromCellText(tok), 7, `${tok} should be July`)
  }
})

test("a label containing a month abbreviation by accident is not a month", () => {
  // "รวมคะแนน" and "แต้มคะแนน" contain "มค" — Thai runs words together, so
  // a bare two-letter token inside them is noise, not January. Reading them
  // as January would reject a correct July upload as month_mismatch.
  for (const label of ["รวมคะแนน", "แต้มคะแนน", "รวมทั้งหมด", "คะแนนรวม", "ประเภทงาน"]) {
    assert.equal(score.monthFromCellText(label), null, `${label} must not read as a month`)
  }
  assert.equal(score.resolveBeMonthFromRows([{ col_1: "รวมคะแนน", col_2: 400 }]), null)
})

test("a sheet titled with a dotted month is picked, and subtotal labels don't derail it", async () => {
  const buffer = await makeSheets(
    ["sheet1", [["รายงาน ม.ค. 2569"], ["รวมคะแนน", 100], ["x", 1]]],
    ["sheet2", [["รายงาน ก.ค. 2569"], ["รวมคะแนน", 400], ["รวมทั้งหมด", 900]]],
  )
  const { sheetName, rows } = await score.parseWorkbookRowsSafely(buffer, { targetMonth: 7, targetYear: 2569 })
  assert.equal(sheetName, "sheet2")
  assert.equal(score.resolveScore(rows).score, 900)
  assert.equal(score.resolveBeMonthFromRows(rows), 7, "the cross-check agrees, so this is not rejected")
})

test("monthYearFromText reads a two-digit year only alongside a month", () => {
  assert.deepEqual(score.monthYearFromText("กค69"), { month: 7, beYear: 2569 })
  assert.deepEqual(score.monthYearFromText("มค67"), { month: 1, beYear: 2567 })
  assert.deepEqual(score.monthYearFromText("กรกฎาคม 2569"), { month: 7, beYear: 2569 })
  assert.deepEqual(score.monthYearFromText("July 2026"), { month: 7, beYear: 2569 })
  // No month token: a bare number is a score, never a year.
  assert.deepEqual(score.monthYearFromText("รวมทั้งหมด 69"), { month: null, beYear: null })
  assert.deepEqual(score.monthYearFromText(null), { month: null, beYear: null })
})

test("resolveBeMonthFromRows catches a month stated in the sheet content, not just the tab name or filename", () => {
  // The gap this guards: generic tab names ("Sheet1") give parseWorkbookRows
  // nothing to match on, and resolveBeMonth alone only ever sees the
  // filename on this path — so a title row is the last remaining signal.
  const rows = [
    { col_1: "รายงานผลงานประจำเดือนมิถุนายน 2569" },
    { col_1: "ประเภทงาน", col_2: "แต้ม" },
    { col_1: "รวมทั้งหมด", col_2: 900 },
  ]
  assert.equal(score.resolveBeMonthFromRows(rows), 6)
})

test("resolveBeMonthFromRows returns null when nothing looks like a month", () => {
  const rows = [
    { col_1: "ประเภทงาน", col_2: "แต้ม" },
    { col_1: "รวมทั้งหมด", col_2: 900 },
  ]
  assert.equal(score.resolveBeMonthFromRows(rows), null)
  assert.equal(score.resolveBeMonthFromRows([]), null)
})

test("resolveBeMonthFromRows only looks at the first 15 rows", () => {
  const rows = Array.from({ length: 20 }, () => ({ col_1: "x" }))
  rows[16] = { col_1: "มิถุนายน" }
  assert.equal(score.resolveBeMonthFromRows(rows), null)
})

test("a workbook must identify itself as the month picked", async () => {
  const body = [["ประเภทงาน", "แต้ม"], ["บริการ", 5], ["รวมทั้งหมด", 700]]
  const at = async (specs) =>
    (await score.parseWorkbookRowsSafely(await makeSheets(...specs), { targetMonth: 7, targetYear: 2569 })).matched

  // Identified — by tab name in any of the forms a real file uses, or by a
  // title row when the tab is generic.
  assert.equal(await at([["ก.ค. 2569", body]]), true, "dotted tab name")
  assert.equal(await at([["กรกฎาคม", body]]), true, "full Thai tab name")
  assert.equal(await at([["Jul-25", body]]), true, "English abbreviation")
  assert.equal(await at([["Sheet1", [["รายงาน ก.ค. 2569"], ...body]]]), true, "title row")
  assert.equal(await at([["sheet1", body], ["ก.ค.", body]]), true, "one sheet of several")

  // Not identified — single-sheet workbooks are held to the same bar.
  assert.equal(await at([["Sheet1", body]]), false, "nothing names a month")
  assert.equal(await at([["sheet1", body], ["sheet2", body]]), false, "no sheet names a month")
  assert.equal(await at([["ก.ค. 2568", body]]), false, "right month, contradicting year")
})
