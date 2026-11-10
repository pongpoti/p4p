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
const score = require(resolve(repoRoot, "lib/p4p-score"))
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

/**
 * A real one-entry zip whose entry inflates to `realBytes` bytes but whose
 * headers declare `declared` bytes: the lie a crafted zip bomb tells to get
 * past a check that only reads the central directory.
 */
function lyingZip({ realBytes, declared, method = 8 }) {
  const zlib = require("node:zlib")
  const name = Buffer.from("xl/worksheets/sheet1.xml")
  const plain = Buffer.alloc(realBytes, 0x20)
  const data = method === 8 ? zlib.deflateRawSync(plain, { level: 9 }) : plain
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(method, 8)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(declared, 22)
  local.writeUInt16LE(name.length, 26)
  const cd = Buffer.alloc(46)
  cd.writeUInt32LE(0x02014b50, 0)
  cd.writeUInt16LE(20, 4)
  cd.writeUInt16LE(20, 6)
  cd.writeUInt16LE(method, 10)
  cd.writeUInt32LE(data.length, 20)
  cd.writeUInt32LE(declared, 24)
  cd.writeUInt16LE(name.length, 28)
  cd.writeUInt32LE(0, 42)
  const body = Buffer.concat([local, name, data])
  const central = Buffer.concat([cd, name])
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(central.length, 12)
  eocd.writeUInt32LE(body.length, 16)
  return Buffer.concat([body, central, eocd])
}

test("an entry that declares a small size but inflates past the cap is refused (audit F18)", () => {
  // 60 MB of spaces declared as 2000 bytes: the declared total passes, the
  // real one does not, and inflating stops at the cap instead of running on.
  const buffer = lyingZip({ realBytes: 60 * 1024 * 1024, declared: 2000 })
  assert.ok(buffer.length < 1024 * 1024, "the bomb itself is small")
  assert.throws(() => score.checkZipSafety(buffer), (err) => {
    assert.equal(err.code, "ZIP_TOO_LARGE")
    return true
  })
})

test("an entry whose real size differs from its header is refused, before ExcelJS sees it", async () => {
  const buffer = lyingZip({ realBytes: 3000, declared: 2000 })
  assert.throws(() => score.checkZipSafety(buffer), (err) => {
    assert.equal(err.code, "ZIP_MALFORMED")
    return true
  })
  await assert.rejects(() => score.parseWorkbookRowsSafely(buffer), (err) => {
    assert.equal(err.code, "ZIP_MALFORMED")
    return true
  })
})

test("a stored (uncompressed) entry counts its real size too", () => {
  assert.throws(() => score.checkZipSafety(lyingZip({ realBytes: 3000, declared: 3000, method: 0 }), { maxUncompressedBytes: 2000 }), (err) => {
    assert.equal(err.code, "ZIP_TOO_LARGE")
    return true
  })
  assert.equal(score.checkZipSafety(lyingZip({ realBytes: 3000, declared: 3000, method: 0 })).uncompressedBytes, 3000)
})

test("an honest entry is counted by what it inflates to", () => {
  assert.equal(score.checkZipSafety(lyingZip({ realBytes: 5000, declared: 5000 })).uncompressedBytes, 5000)
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

// ── Archives that JSZip reads differently from a plain central-directory walk ──
//
// Each one shows the guard a small honest entry and JSZip (inside ExcelJS) a
// hidden one that inflates to 60 MB while its headers declare 2000 bytes.
// JSZip lists the hidden entry without inflating anything, so listing it
// proves the archive really does what it claims; the guard must refuse it.
const HIDDEN = "xl/media/image1.png"
const SMALL = "xl/worksheets/a.xml"  // as long as HIDDEN, so both records are one size
const zlib = require("node:zlib")
const jszip = createRequire(require.resolve("exceljs"))("jszip")
const bombData = zlib.deflateRawSync(Buffer.alloc(60 * 1024 * 1024), { level: 9 })

/** A local header plus data, and the central-directory record that points at it. */
function zipEntry(name, { data, declared }) {
  const nameBuf = Buffer.from(name)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(declared, 22)
  local.writeUInt16LE(nameBuf.length, 26)
  const record = (localOffset) => {
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(8, 10)
    cd.writeUInt32LE(data.length, 20)
    cd.writeUInt32LE(declared, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt32LE(localOffset, 42)
    return Buffer.concat([cd, nameBuf])
  }
  return { body: Buffer.concat([local, nameBuf, data]), record }
}

function endRecord({ total, cdSize, cdOffset, disk = 0 }) {
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(disk, 4)
  eocd.writeUInt16LE(total, 8)
  eocd.writeUInt16LE(total, 10)
  eocd.writeUInt32LE(cdSize, 12)
  eocd.writeUInt32LE(cdOffset, 16)
  return eocd
}

// Bytes that barely compress, so the small entry is longer than one record.
const smallPlain = Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 7919) % 251))
const small = () => zipEntry(SMALL, { data: zlib.deflateRawSync(smallPlain), declared: smallPlain.length })
const hidden = () => zipEntry(HIDDEN, { data: bombData, declared: 2000 })

/** The end record counts one entry; the central directory holds two. */
function undercountZip() {
  const a = small(), b = hidden()
  const body = Buffer.concat([a.body, b.body])
  const cd = Buffer.concat([a.record(0), b.record(a.body.length)])
  return Buffer.concat([body, cd, endRecord({ total: 1, cdSize: cd.length, cdOffset: body.length })])
}

/**
 * A gap between the central directory the end record names and the end
 * record itself: JSZip takes the gap for prepended bytes and shifts every
 * offset by it, which lands on a second central directory.
 */
function shiftedZip() {
  const a = small(), b = hidden()
  const body = Buffer.concat([a.body, b.body])
  const decoy = a.record(0)
  const shift = decoy.length
  const real = b.record(a.body.length - shift)  // JSZip adds the shift back
  assert.equal(real.length, shift, "both records are the same size")
  return Buffer.concat([body, decoy, real, endRecord({ total: 1, cdSize: decoy.length, cdOffset: body.length })])
}

/** A 0xFFFF end-record field sends JSZip to a ZIP64 record that names another central directory. */
function zip64MarkerZip() {
  const a = small(), b = hidden()
  const body = Buffer.concat([a.body, b.body])
  const decoy = a.record(0)
  const real = b.record(a.body.length)
  const realAt = body.length + decoy.length
  const z64 = Buffer.alloc(56)
  z64.writeUInt32LE(0x06064b50, 0)
  z64.writeBigUInt64LE(44n, 4)
  z64.writeUInt16LE(45, 12)
  z64.writeUInt16LE(45, 14)
  z64.writeBigUInt64LE(1n, 24)
  z64.writeBigUInt64LE(1n, 32)
  z64.writeBigUInt64LE(BigInt(real.length), 40)
  z64.writeBigUInt64LE(BigInt(realAt), 48)
  const locator = Buffer.alloc(20)
  locator.writeUInt32LE(0x07064b50, 0)
  locator.writeBigUInt64LE(BigInt(realAt + real.length), 8)
  locator.writeUInt32LE(1, 16)
  return Buffer.concat([
    body, decoy, real, z64, locator,
    endRecord({ total: 1, cdSize: decoy.length, cdOffset: body.length, disk: 0xffff }),
  ])
}

for (const [label, build, code] of [
  ["an end record that undercounts the central directory", undercountZip, "ZIP_MALFORMED"],
  ["a gap JSZip reads as prepended data", shiftedZip, "ZIP_MALFORMED"],
  ["a ZIP64 marker in the end record", zip64MarkerZip, "ZIP64_UNSUPPORTED"],
]) {
  test(`${label} is refused: JSZip would inflate an entry the guard never counted`, async () => {
    const buffer = build()
    assert.ok(buffer.length < 200 * 1024, "the archive itself is small")
    const listed = Object.keys((await jszip.loadAsync(buffer)).files)
    assert.ok(listed.includes(HIDDEN), `JSZip reads the hidden entry (it listed ${listed.join(", ")})`)
    assert.throws(() => score.checkZipSafety(buffer), (err) => {
      assert.equal(err.code, code)
      return true
    })
    await assert.rejects(() => score.parseWorkbookRowsSafely(buffer), (err) => {
      assert.equal(err.code, code)
      return true
    })
  })
}

test("an end-of-central-directory signature in the last 21 bytes is refused", () => {
  // JSZip reads the last signature in the file; one too close to the end to
  // hold a whole record is not one the guard should read past.
  const buffer = Buffer.concat([lyingZip({ realBytes: 3000, declared: 3000 }), Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0])])
  assert.throws(() => score.checkZipSafety(buffer), (err) => {
    assert.equal(err.code, "NOT_A_ZIP")
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

test("a contradicting tab name no longer vetoes a sheet whose content agrees with the target", async () => {
  // The real incident this guards: a physician's workbook has several
  // sheets; the first tab is still labelled "กค 69" (July) — copied from
  // last month's file and never renamed — but its own title row and the
  // subject line both say "สค 69" (August). Before this fix the
  // contradicting tab name scored 0 and was never rescued by content, so a
  // multi-sheet workbook where every other tab also failed to name August
  // was refused outright as month_not_found even though the right sheet
  // (and the right data) was sitting right there.
  const buffer = await makeSheets(
    ["กค 69", [["รายงานผลงาน สค 69"], ["ประเภทงาน", "แต้ม"], ["รวมทั้งหมด", 900]]],
    ["มิย 69", [["ประเภทงาน", "แต้ม"], ["รวมทั้งหมด", 100]]],
  )
  assert.equal(score.sheetMatchScore({ name: "กค 69" }, [{ col_1: "รายงานผลงาน สค 69" }], 8, 2569), 2,
    "contradicting name (score 0) must not block the content tier (score 2, year agrees too) from winning")
  const { sheetName, matched, rows } = await score.parseWorkbookRowsSafely(buffer, { targetMonth: 8, targetYear: 2569 })
  assert.equal(matched, true, "content-agreeing sheet must count as identified, despite the stale tab name")
  assert.equal(sheetName, "กค 69")
  assert.equal(score.resolveScore(rows).score, 900)
})

test("a tab name that agrees with the target still outranks another sheet's content, even after the max-of-tiers fix", async () => {
  // Regression guard for the fix above: taking the max of the two tiers must
  // not accidentally let content ever beat an agreeing tab name (4/3 vs 2/1).
  const buffer = await makeSheets(
    ["ก.ค. 2569", [["ประเภทงาน", "แต้ม"], ["รวมทั้งหมด", 900]]],
    ["other", [["รายงาน ก.ค. 2569"], ["ประเภทงาน", "แต้ม"], ["รวมทั้งหมด", 100]]],
  )
  const { sheetName } = await score.parseWorkbookRowsSafely(buffer, { targetMonth: 7, targetYear: 2569 })
  assert.equal(sheetName, "ก.ค. 2569")
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

test("a month abbreviation embedded in a person's name is not a month, in a tab name or cell either", () => {
  // "ณัฐกันย์" (a real given name) contains "กันย" — the abbreviation for
  // กันยายน (September) — as a plain substring, with no space around it. A
  // sheet tab or title cell named after the physician must not read as
  // September, the same rule already enforced for subjects/filenames.
  assert.equal(score.monthFromCellText("ณัฐกันย์"), null)
  assert.equal(score.monthFromCellText("ณัฐกันย์ ลิมปวิทยากุล"), null)
  assert.deepEqual(score.monthYearFromText("ณัฐกันย์ ลิมปวิทยากุล"), { month: null, beYear: null })
  const ws = { name: "ณัฐกันย์ ลิมปวิทยากุล" }
  assert.equal(score.sheetMatchScore(ws, [], 9, null), 0, "must not score as September")
  // The เดือน<month> compound (no space) the repo's own title rows use must
  // still resolve — the fix above must not re-break it.
  assert.equal(score.monthFromCellText("รายงานผลงานประจำเดือนมิถุนายน"), 6)
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

test("a multi-sheet workbook must identify itself, by tab name or title row", async () => {
  const body = [["ประเภทงาน", "แต้ม"], ["บริการ", 5], ["รวมทั้งหมด", 700]]
  const at = async (specs) =>
    (await score.parseWorkbookRowsSafely(await makeSheets(...specs), { targetMonth: 7, targetYear: 2569 })).matched

  // Identified — by tab name in any of the forms a real file uses, or by a
  // title row when the tab is generic. All fixtures here carry TWO non-blank
  // sheets, so content is still the signal (see the single-sheet tests below
  // for the different rule that applies when there is exactly one).
  assert.equal(await at([["ก.ค. 2569", body], ["other", body]]), true, "dotted tab name")
  assert.equal(await at([["กรกฎาคม", body], ["other", body]]), true, "full Thai tab name")
  assert.equal(await at([["Jul-25", body], ["other", body]]), true, "English abbreviation")
  assert.equal(await at([["Sheet1", [["รายงาน ก.ค. 2569"], ...body]], ["Sheet2", body]]), true, "title row")
  assert.equal(await at([["sheet1", body], ["ก.ค.", body]]), true, "one sheet of several")

  // Not identified.
  assert.equal(await at([["sheet1", body], ["sheet2", body]]), false, "no sheet names a month")
  assert.equal(await at([["ก.ค. 2568", body], ["other", body]]), false, "right month, contradicting year")
})

test("a single-sheet workbook is judged by filename, not by its own tab/content", async () => {
  // The real incident this rule exists for: a June submission whose only
  // sheet was still tabbed "พ.ย. 68" (November) from a reused prior-month
  // file. The email path scored it fine via the subject line; the LIFF path
  // rejected it twice as month_not_found — including after the physician
  // renamed the FILE, because the check was reading the tab, not the name.
  const body = [["ประเภทงาน", "แต้ม"], ["บริการ", 5], ["รวมทั้งหมด", 700]]
  const at = async (tabName, filename) =>
    (await score.parseWorkbookRowsSafely(await makeSheets([tabName, body]), {
      targetMonth: 6, targetYear: 2569, filename,
    })).matched

  // A stale/contradicting/blank tab is not held against the file, or trusted
  // in its favour — it simply isn't consulted once the filename decides.
  assert.equal(await at("พ.ย. 68", "มัทวัน วรทล มิ.ย. 69.xlsx"), true, "filename names June despite a November tab")
  assert.equal(await at("มิถุนายน 2569", "P4P.xlsx"), false, "a correctly-tabbed sheet no longer counts on its own")
  assert.equal(await at("Sheet1", "P4P.xlsx"), false, "neither tab nor filename names a month")
  assert.equal(await at("Sheet1", "P4P พฤษภาคม 2569.xlsx"), false, "filename names a different month (a mismatch, checked separately in main.js)")
})

test("a month number beside a year in the filename counts as the month", async () => {
  // The real report: "P4P_9_2026.xlsx" uploaded for September was refused as
  // month_not_found, because only month NAMES were read from the filename.
  const body = [["ประเภทงาน", "แต้ม"], ["บริการ", 5], ["รวมทั้งหมด", 700]]
  const at = async (filename) =>
    (await score.parseWorkbookRowsSafely(await makeSheets(["data", body]), {
      targetMonth: 9, targetYear: 2569, filename,
    })).matched

  assert.equal(await at("P4P_9_2026.xlsx"), true)
  assert.equal(await at("P4P 09-2569.xlsx"), true)
  assert.equal(await at("2569_09.xlsx"), true)
  assert.equal(await at("P4P_10_2026.xlsx"), false, "a different month number")
  assert.equal(await at("P4P_9.xlsx"), false, "a number with no year beside it is not a month")
})

test("resolveFilenameMonth: names first, then a number beside a year", () => {
  assert.equal(score.resolveFilenameMonth("P4P_9_2026.xlsx"), 9)
  assert.equal(score.resolveFilenameMonth("2026.12 P4P.xlsx"), 12)
  assert.equal(score.resolveFilenameMonth("P4P กันยายน 2569.xlsx"), 9)
  assert.equal(score.resolveFilenameMonth("P4P_13_2026.xlsx"), null)
  assert.equal(score.resolveFilenameMonth("P4P_2026.xlsx"), null)
  assert.equal(score.resolveFilenameMonth("P4P.xlsx"), null)
})
