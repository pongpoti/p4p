/**
 * The nightly build's side of the ตรวจสอบ tab (process/review-build.ts):
 * reading a doctor's own file (saved values only, the sheet merge.py copies)
 * and reading the built SK03's rows back. Skips when process/'s
 * dependencies are not installed.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
let rb = null, ExcelJS = null
try {
  rb = require(resolve(repoRoot, "process/review-build"))
  ExcelJS = require("exceljs")
} catch {
  rb = null
}
const p4p = require(resolve(repoRoot, "lib/p4p-score"))
const skip = rb ? false : "process/ dependencies not installed"

test("review tables missing vs a passing outage", { skip }, () => {
  assert.equal(rb.missingTable({ code: "PGRST205", message: "Could not find the table 'public.review_builds' in the schema cache" }), true)
  assert.equal(rb.missingTable({ code: "42P01", message: 'relation "public.review_inputs" does not exist' }), true)
  assert.equal(rb.missingTable({ message: 'relation "public.review_inputs" does not exist' }), true)
  // PGRST002 while PostgREST or the database restarts: not "not installed".
  assert.equal(rb.missingTable({ code: "PGRST002", message: "Could not query the database for the schema cache. Retrying." }), false)
  assert.equal(rb.missingTable({ code: "42704", message: 'role "x" does not exist' }), false)
  assert.equal(rb.missingTable(null), false)
})

test("nightly run: months whose review is on the auditee's side", { skip }, async () => {
  const asked = []
  const fake = (rows, error = null) => ({
    from: (table) => {
      const q = { select: () => q, in: (col, vals) => { asked.push([table, col, vals]); return q },
        then: (ok, bad) => Promise.resolve({ data: rows, error }).then(ok, bad) }
      return q
    },
  })
  // ส.ค. 69 sent and with the auditor, ก.ย. 69 approved, ต.ค. 69 never sent.
  const got = await rb.auditeeSideMonths(fake([{ month: "2569_08" }, { month: "2569_09" }]),
    ["2569_10", "2569_09", "2569_08", "2569_07", "x"])
  assert.deepEqual([...got], ["2569_10"])
  assert.deepEqual(asked, [["review_rounds", "month", ["2569_10", "2569_09", "2569_08"]],
    ["review_rounds", "status", ["submitted", "approved"]]])
  // Sent back to the auditee (returned) or never sent: theirs again.
  assert.deepEqual([...await rb.auditeeSideMonths(fake([]), ["2569_09", "2569_08"])], ["2569_09", "2569_08"])
  // Before ส.ค. 69 there is no review; nothing is asked.
  asked.length = 0
  assert.deepEqual([...await rb.auditeeSideMonths(fake([]), ["2569_07", "2569_06"])], [])
  assert.equal(asked.length, 0)
  // Tables not installed: none. Any other error stops the look.
  assert.deepEqual([...await rb.auditeeSideMonths(fake(null, { code: "42P01", message: 'relation "public.review_rounds" does not exist' }), ["2569_08"])], [])
  await assert.rejects(rb.auditeeSideMonths(fake(null, { code: "PGRST002", message: "Retrying." }), ["2569_08"]), /review_rounds read error/)
})

test("saved values: a formula's cached result, never the formula", { skip }, () => {
  assert.deepEqual(rb.savedValue({ formula: "SUM(B2:B3)", result: 54.5 }), { value: 54.5, uncached: false })
  assert.deepEqual(rb.savedValue({ formula: "SUM(B2:B3)" }), { value: null, uncached: true })
  assert.deepEqual(rb.savedValue({ sharedFormula: "B2", result: 3 }), { value: 3, uncached: false })
  assert.deepEqual(rb.savedValue({ richText: [{ text: "รวม" }, { text: "ทั้งหมด" }] }), { value: "รวมทั้งหมด", uncached: false })
})

test("doctor's file: first sheet with data, stated total and snapshot", { skip }, async () => {
  const wb = new ExcelJS.Workbook()
  wb.addWorksheet("ว่าง").getCell("A1").value = "หัวเรื่องเท่านั้น"
  const ws = wb.addWorksheet("P4P")
  ws.addRow(["งาน", "แต้ม", "จำนวน", "รวม"])
  ws.addRow(["ตรวจผู้ป่วยนอก", 2, 10, { formula: "B2*C2", result: 20 }])
  ws.addRow(["เวร", 5, 3, { formula: "B3*C3", result: 15 }])
  ws.addRow(["รวมแต้มทั้งหมด", null, null, { formula: "D2+D3", result: 40 }]) // added up wrong on purpose
  ws.mergeCells("A1:B1")
  const buf = Buffer.from(await wb.xlsx.writeBuffer())
  const a = await rb.analyseDoctorFile(buf)
  assert.deepEqual(a.stated, { value: 40, cell: "D4", how: "grand-total" })
  assert.equal(a.grid.sheet, "P4P")
  assert.equal(a.grid.rows, 4)
  assert.equal(a.grid.cols, 4)
  assert.ok(a.grid.cells.some(([r, c, v]) => r === 3 && c === 3 && v === 40))
  assert.deepEqual(a.grid.merges, ["A1:B1"])
  assert.match(a.sha256, /^[0-9a-f]{64}$/)
})

test("doctor's file: a total never saved by Excel gets the workflow's own fallback", { skip }, async () => {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet("P4P")
  ws.addRow(["งาน", "รวม"])
  ws.addRow(["ก", 100])
  ws.addRow(["รวมทั้งหมด", { formula: "B2" }])
  const buf = Buffer.from(await wb.xlsx.writeBuffer())
  const a = await rb.analyseDoctorFile(buf)
  // The workflow's full rule (Pong, 2026-11-10): what it would have scored.
  assert.deepEqual(a.stated, { value: 100, cell: "B2", how: "largest-in-sheet" })
  assert.equal(p4p.resolveScore((await p4p.parseWorkbookRows(buf)).rows).score, 100)
  // Nothing at all to read: still reported as an unsaved total.
  const wb2 = new ExcelJS.Workbook()
  wb2.addWorksheet("P4P").addRow(["งาน", "ไม่มี"])
  wb2.worksheets[0].addRow(["รวมทั้งหมด", { formula: "B9" }])
  const b = await rb.analyseDoctorFile(Buffer.from(await wb2.xlsx.writeBuffer()))
  assert.deepEqual(b.stated, { value: null, cell: null, how: "uncached" })
})

test("pipeline values: each cell as the submission pipeline reads it", { skip }, () => {
  const v = (cell) => rb.pipelineValue(cell)
  assert.deepEqual(v({ value: { formula: "SUM(B2:B3)", result: 54.5 }, result: 54.5 }), { value: 54.5, uncached: false })
  // ExcelJS drops a falsy result from cell.value; cell.result keeps it. A saved 0 is a value.
  assert.deepEqual(v({ value: { formula: "SUM(B2:B3)" }, result: 0 }), { value: 0, uncached: false })
  assert.deepEqual(v({ value: { formula: "SUM(B2:B3)" }, result: undefined }), { value: null, uncached: true })
  // A shared-formula copy counts only as a number.
  assert.deepEqual(v({ value: { sharedFormula: "B2", result: 3 }, result: 3 }), { value: 3, uncached: false })
  assert.deepEqual(v({ value: { sharedFormula: "B2", result: "ก" }, result: "ก" }), { value: null, uncached: false })
  // A merged copy of a formula cell: no value of its own, but not uncached.
  assert.deepEqual(v({ value: { formula: "B2", result: 7 }, result: undefined, master: { result: 7 } }), { value: null, uncached: false })
  assert.deepEqual(v({ value: { formula: "TODAY()" }, result: new Date("2026-11-01T00:00:00Z") }),
    { value: "2026-11-01T00:00:00.000Z", uncached: false })
  assert.deepEqual(v({ value: new Date("2026-10-31T00:00:00Z") }), { value: "2026-10-31T00:00:00.000Z", uncached: false })
  assert.deepEqual(v({ value: { richText: [{ text: "รวม" }, { text: "ทั้งหมด" }] } }), { value: "รวมทั้งหมด", uncached: false })
  assert.deepEqual(v({ value: { text: "ลิงก์", hyperlink: "https://example.com" } }), { value: "ลิงก์", uncached: false })
  assert.deepEqual(v({ value: true }), { value: true, uncached: false })
})

test("doctor's file: the stated total is the number the pipeline read from the same file", { skip }, async () => {
  const H = ["ประเภทงาน", "กิจกรรม", "แต้ม", "จำนวนรวม", "รวมแต้ม"]
  const books = {
    // shared formulas, a merged title, a rich-text label, a total in the year range
    sharedFormulas: (ws) => {
      ws.addRow(["แบบบันทึกภาระงาน เดือน ตุลาคม 2569"])
      ws.mergeCells("A1:E1")
      ws.addRow(H)
      ws.addRow(["OPD", "ตรวจ", 10, 120, { formula: "C3*D3", result: 1200, shareType: "shared", ref: "E3:E5" }])
      ws.addRow(["IPD", "ราวด์", 20, 37, { sharedFormula: "E3", result: 740 }])
      ws.addRow(["เวร", "บ่าย", 0, 0, { sharedFormula: "E3", result: 0 }])
      ws.addRow([{ richText: [{ text: "รวมแต้ม" }, { text: "ทั้งหมด" }] }, null, null,
        { formula: "SUM(D3:D5)", result: 157 }, { formula: "SUM(E3:E5)", result: 1940 }])
      ws.addRow(["วันที่", new Date("2026-10-31T00:00:00Z"), true, { text: "ลิงก์", hyperlink: "https://example.com" }])
      return { value: 1940, cell: "E6", how: "grand-total" }
    },
    // the grand-total formula saved 0: a value, not an unsaved formula
    savedZero: (ws) => {
      ws.addRow(["งาน", "แต้ม"])
      ws.addRow(["ก", 20])
      ws.addRow(["รวม", 30])
      ws.addRow(["รวมทั้งหมด", { formula: "B9" }])
      ws.getCell("B4").value = { formula: "B9", result: 0 }
      return { value: 30, cell: "B3", how: "sub-total" }
    },
    freeText: (ws) => {
      ws.addRow(H)
      ws.addRow(["OPD", "ตรวจ", 10, 100, 1000])
      ws.addRow(["IPD", "ราวด์", 1320, 1, 1320])
      ws.addRow([null, null, null, null, "รวม =  3260"])
      return { value: 3260, cell: "E4", how: "free-text" }
    },
    // the pipeline reads the whole sheet, however far down the total is
    farDown: (ws) => {
      ws.addRow(["งาน", "แต้ม"])
      ws.addRow(["ก", 20])
      ws.getCell("A2050").value = "รวม แต้ม ทั้งหมด"
      ws.getCell("HZ2050").value = 2310
      return { value: 2310, cell: "HZ2050", how: "grand-total" }
    },
    // "รวม" out in AB15 (merged to AJ15), its total saved in AK15
    totalPastC: (ws) => {
      ws.getCell("A4").value = "กิจกรรม"
      ws.getCell("AB4").value = "แต้ม"
      ws.getCell("A6").value = "ตรวจผู้ป่วย"
      ws.getCell("AK6").value = 3300
      ws.getCell("A7").value = "วางแผนการรักษา"
      ws.getCell("AK7").value = 3305
      ws.getCell("AB15").value = "รวม"
      ws.mergeCells("AB15:AJ15")
      ws.getCell("AK15").value = { formula: "SUM(AK6:AK14)", result: 6605 }
      return { value: 6605, cell: "AK15", how: "largest-on-total-row" }
    },
    // no total saved anywhere: the workflow rebuilt it from daily counts × แต้ม
    rebuiltFromDays: (ws) => {
      ws.addRow(["งาน", "D1", "D2", "D3", "แต้ม", "รวมแต้ม"])
      ws.addRow(["ก", 2, 1, 0, 1500.25, { formula: "SUM(B2:D2)*E2" }])
      ws.addRow(["ข", 1, null, 1, 1882, { formula: "SUM(B3:D3)*E3" }])
      ws.addRow(["รวมแต้มทั้งหมด", null, null, null, null, { formula: "SUM(F2:F3)" }])
      return { value: 8264.75, cell: null, how: "rebuilt-from-days" }
    },
  }
  for (const [label, build] of Object.entries(books)) {
    const wb = new ExcelJS.Workbook()
    const want = build(wb.addWorksheet("P4P"))
    const buf = Buffer.from(await wb.xlsx.writeBuffer())
    const a = await rb.analyseDoctorFile(buf)
    assert.deepEqual(a.stated, want, label)
    // The workflow's full rule on the pipeline's own reading of the file.
    assert.equal(a.stated.value, p4p.resolveScore((await p4p.parseWorkbookRows(buf)).rows).score, label)
  }
})

// packageReviewBuild against stand-ins for Sheets, Drive and Supabase that
// keep every review_builds row inserted.
function fakeServices() {
  const builds = []
  const updates = []
  const from = (table) => {
    const api = {
      select: () => api, eq: () => api, order: () => api, limit: () => api, lt: () => api, in: () => api, delete: () => api,
      update: (row) => { updates.push([table, row]); return api },
      maybeSingle: async () => ({ data: table === "review_builds" ? builds[builds.length - 1] ?? null : null, error: null }),
      insert: async (row) => { if (table === "review_builds") builds.push(row); return { error: null } },
      then: (ok, bad) => Promise.resolve({ data: table === "review_builds" ? builds : [], error: null }).then(ok, bad),
    }
    return api
  }
  const supabase = { from, storage: { from: () => ({ upload: async () => ({ error: null }), remove: async () => ({ error: null }) }) } }
  const staff = [
    [1, "นพ.", "ทดสอบ", "หนึ่ง", "", "", "", 2200, 0, 3000, 3000, 800, 0, 12000, 12000],
    [2, "พญ.", "ทดสอบ", "สอง", "", "", "", 2200, 0, 2800.5, 2800.5, 600.5, 0, 11000, 11000],
  ]
  const dept = [[], ["ประจำเดือน"], ["หน่วยงาน"], [], [],
    [1, "นพ. ทดสอบ  หนึ่ง", "นายแพทย์", "", 0, 12000, 12000], [2, "พญ. ทดสอบ  สอง", "นายแพทย์", "", 0, 11000, 11000]]
  const sheets = { spreadsheets: {
    get: async () => ({ data: { sheets: ["staff", "intern", "งบรายสาขา", "อายุรกรรม"].map((title) => ({ properties: { title } })) } }),
    values: {
      batchGet: async () => ({ data: { valueRanges: [{ values: staff }, { values: [] }, { values: [[5000000]] }, { values: dept }] } }),
      get: async () => ({ data: { values: [["=W10*9906.44"]] } }),
    },
  } }
  const drive = { files: { export: async () => ({ data: new Uint8Array([1, 2, 3]).buffer }) } }
  return { builds, updates, supabase, sheets, drive }
}

test("build fingerprint: the same month read in another order keeps the newest build", { skip }, async () => {
  const { builds, updates, supabase, sheets, drive } = fakeServices()
  const person = (index, prefix, lastname) =>
    ({ index, prefix, firstname: "ทดสอบ", lastname, fullname: "ทดสอบ " + lastname, department: "อายุรกรรม", submitted_at: null })
  const persons = [person("a1", "นพ.", "หนึ่ง"), person("b2", "พญ.", "สอง"), person("c3", "นพ.", "สาม"), person("d4", "พญ.", "สี่")]
  const doc = { sheetName: "x", sha256: "a".repeat(64), stated: { value: 3000, cell: "E9", how: "grand-total" }, grid: null }
  const base = {
    drive, sheets, supabase, monthKey: "2569_10", ssId: "x", staffSheetName: "staff", internSheetName: "intern",
    docs: new Map([["ทดสอบ หนึ่ง", doc], ["ทดสอบ สอง", doc]]), mergedBuffer: Buffer.from("m"),
    input: { budget: 5000000, per_p4p: 9906.44 }, requestId: null, mergedFileId: "merged-1", v2: true,
  }
  const first = await rb.packageReviewBuild({ ...base, persons })
  assert.equal(first.reused, false)
  assert.equal(builds[0].sk03_file_id, "x")
  assert.equal(builds[0].merged_file_id, "merged-1")
  // Kept as the newest: it now links this run's new SK03 Sheet.
  const again = await rb.packageReviewBuild({ ...base, ssId: "y", persons: [...persons].reverse() })
  assert.deepEqual(again, { id: first.id, reused: true })
  assert.deepEqual(updates, [["review_builds", { sk03_file_id: "y", merged_file_id: "merged-1" }]])
  // Before the second SQL file there is no merged_file_id column.
  const old = fakeServices()
  await rb.packageReviewBuild({ ...base, supabase: old.supabase, sheets: old.sheets, drive: old.drive, persons, v2: false })
  assert.equal("merged_file_id" in old.builds[0], false)
  const other = await rb.packageReviewBuild({ ...base, persons: [persons[2], persons[0], persons[3], persons[1]] })
  assert.deepEqual(other, { id: first.id, reused: true })
  assert.equal(builds.length, 1)

  // Problem names in a fixed order, and each department row's sheet row.
  const missing = builds[0].problems.find((p) => p.code === "no_doctor_sheet")
  assert.deepEqual(missing.names, [...missing.names].sort())
  assert.equal(missing.count, 2)
  assert.deepEqual(builds[0].depts.map((d) => d.rowNos), [[6, 7]])
  assert.equal(builds[0].depts[0].rows.length, 2)
})

test("SK03 rows read back: staff/intern and department sheets", { skip }, () => {
  const overall = rb.overallRows([
    [1, "นพ.", "สมชาย", "ใจดี", "นายแพทย์", "", "", 2200, 0, 3100, 3100, 900, 0, 11500, 11500],
    [2, "พญ.", "สมหญิง", " รักงาน", "นายแพทย์", "", "", 2200, 0, 2500, 2500, 300, 0, 10900, 10900],
    ["", "", "", "", "", "", "", "", "", "", "", "", 0, 22400, 22400],
  ], 8)
  assert.deepEqual(overall, [
    { row: 8, key: "สมชาย ใจดี", score: 3100, pay: 11500 },
    { row: 9, key: "สมหญิง รักงาน", score: 2500, pay: 10900 },
  ])
  const dept = rb.deptRows([
    ["แบบ สก.03"], ["ประจำเดือน"], ["หน่วยงาน อายุรกรรม"], ["ที่", "ชื่อ"], ["", ""],
    [1, "นพ. สมชาย  ใจดี", "นายแพทย์", "", 0, 11500, 11500],
    [2, "พญ. สมหญิง  รักงาน", "นายแพทย์", "", 1000, 10900, 11900],
    [],
    ["....หัวหน้างาน"],
  ])
  assert.equal(dept.length, 2)
  assert.deepEqual(dept.map((d) => [d.row, d.key, d.admin, d.pay, d.total]), [
    [6, "นพ. สมชาย ใจดี", 0, 11500, 11500],
    [7, "พญ. สมหญิง รักงาน", 1000, 10900, 11900],
  ])
})
