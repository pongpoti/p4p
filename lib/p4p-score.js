/**
 * lib/p4p-score.js
 *
 * Root-side (CommonJS, Vercel/main.js) copy of the pure, no-network scoring
 * arithmetic that `automation/claude-analyst.js` owns canonically. This file
 * exists because of C8 (main.js and automation/ are deliberately isolated
 * sub-projects with separate package.json/module-format — root is CommonJS,
 * automation/ is ESM — so real code sharing would mean merging their
 * dependency trees, a bigger structural change than this feature justifies).
 *
 * `extractScoreFromRows` / `resolveScore` below are byte-faithful ports of
 * the same-named exports in automation/claude-analyst.js — DO NOT edit one
 * without the other. `web/lib/__tests__/parity.test.ts` already establishes
 * the pattern this repo uses for exactly this situation (a vendored copy plus
 * an automated test that fails loudly the moment the copies diverge); see
 * lib/__tests__/parity.test.js for this pair's version of that test.
 *
 * `resolveBeMonth` / `resolveBeYear` / `resolveBeYearFromRows` are also
 * ported (same file, same reason) — narrower in scope than the design's
 * headline "just resolveScore/extractScoreFromRows" phrasing, but needed
 * here too: §7.8 step 5 of UPLOAD_VIA_LINE_DESIGN.md requires this route to
 * cross-check the file's own inferred month against the physician's selected
 * `month_key` (a `month_mismatch` rejection), and these three functions are
 * pure text/row scans with no dependency on the name-resolution machinery
 * that stays behind in automation/ only. They are covered by the same parity
 * test as the scoring functions.
 *
 * What is deliberately NOT here: `analyseJson` (calls Claude), physician
 * name resolution, Drive upload. Those stay exclusively in automation/,
 * reached only through the two claim functions — this route never calls
 * Claude and never touches Drive (§7.8).
 */
"use strict"

// ── Month resolution (ported from automation/claude-analyst.js) ───────────

/**
 * Extract and convert any year expression to a 4-digit BE year. Mirrors
 * automation/claude-analyst.js's resolveBeYear exactly.
 */
function resolveBeYear(filename, subject, body, emailDate = null) {
  const all = [subject ?? "", body ?? "", filename ?? ""]
  const noBody = [subject ?? "", filename ?? ""]

  const tier1 = all
    .map((t) => t.match(/(?<!\d)(25\d{2})(?!\d)/))
    .filter(Boolean)
    .map((m) => parseInt(m[1], 10))
  if (tier1.length) return Math.max(...tier1)

  const tier2 = all
    .map((t) => t.match(/(?<!\d)(20\d{2})(?!\d)/))
    .filter(Boolean)
    .map((m) => parseInt(m[1], 10) + 543)
  if (tier2.length) return Math.max(...tier2)

  const tier3 = all
    .map((t) => t.match(/(?<!\d)(4[3-9]|[5-9]\d)(?!\d)/))
    .filter(Boolean)
    .map((m) => 2500 + parseInt(m[1], 10))
  if (tier3.length) return Math.max(...tier3)

  const tier4 = noBody
    .map((t) => t.match(/(?<!\d)([0-3]\d|4[0-2])(?!\d)/))
    .filter(Boolean)
    .map((m) => 2000 + parseInt(m[1], 10) + 543)
  if (tier4.length) return Math.max(...tier4)

  if (emailDate) {
    const d = new Date(emailDate)
    if (!isNaN(d.getTime())) return d.getFullYear() + 543
  }

  return null
}

/** Mirrors automation/claude-analyst.js's resolveBeYearFromRows exactly. */
function resolveBeYearFromRows(rows) {
  const beYearRe = /(?<!\d)(25\d{2})(?!\d)/
  const ceYearRe = /(?<!\d)(20\d{2})(?!\d)/
  for (const row of rows.slice(0, 15)) {
    for (const val of Object.values(row)) {
      if (val === null || val === undefined) continue
      const s = String(val)
      let m = s.match(beYearRe)
      if (m) return parseInt(m[1], 10)
      m = s.match(ceYearRe)
      if (m) return parseInt(m[1], 10) + 543
    }
  }
  return null
}

/** Mirrors automation/claude-analyst.js's MONTH_TOKEN_MAP exactly. */
const MONTH_TOKEN_MAP = [
  ["มกราคม",1],["January",1],["Jan",1],["ม.ค",1],["มกรา",1],["มกร",1],["มค",1],
  ["กุมภาพันธ์",2],["February",2],["Feb",2],["ก.พ",2],["กุมภา",2],["กุมภ",2],["กพ",2],
  ["มีนาคม",3],["March",3],["Mar",3],["มี.ค",3],["มีนา",3],["มีน",3],["มีค",3],
  ["เมษายน",4],["April",4],["Apr",4],["เม.ย",4],["เมษา",4],["เมษ",4],["เมย",4],
  ["เมศายน",4],["เมศา",4],["เมศ",4],
  ["พฤษภาคม",5],["May",5],["พ.ค",5],["พฤษภ",5],["พฤษ",5],["พค",5],
  ["พฤศภาคม",5],["พฤศภ",5],
  ["มิถุนายน",6],["June",6],["Jun",6],["มิ.ย",6],["มิถุน",6],["มิถุ",6],["มิย",6],
  ["กรกฎาคม",7],["July",7],["Jul",7],["ก.ค",7],["กรกฎ",7],["กรก",7],["กค",7],
  ["สิงหาคม",8],["August",8],["Aug",8],["ส.ค",8],["สิงหา",8],["สิงห",8],["สค",8],
  ["กันยายน",9],["September",9],["Sep",9],["ก.ย",9],["กันยา",9],["กันย",9],["กย",9],
  ["ตุลาคม",10],["October",10],["Oct",10],["ต.ค",10],["ตุลา",10],["ตุล",10],["ตค",10],
  ["พฤศจิกายน",11],["November",11],["Nov",11],["พ.ย",11],["พฤศจิ",11],["พฤศ",11],["พย",11],
  ["พฤษจิกายน",11],["พฤษจิ",11],
  ["ธันวาคม",12],["December",12],["Dec",12],["ธ.ค",12],["ธันวา",12],["ธันว",12],["ธค",12],
]

/** Mirrors automation/claude-analyst.js's resolveBeMonth exactly. */
function resolveBeMonth(filename, subject, body) {
  const sources = [subject ?? "", body ?? "", filename ?? ""]
  for (const t of sources) {
    for (const [token, mo] of MONTH_TOKEN_MAP) {
      if (/^[A-Za-z]+$/.test(token)) {
        if (new RegExp(`\\b${token}\\b`, "i").test(t)) return mo
      } else if (t.includes(token)) {
        return mo
      }
    }
  }
  return null
}

/**
 * Mirrors automation/claude-analyst.js's monthFromCellText exactly — see
 * there for why cell text needs a stricter matcher than resolveBeMonth.
 */
function monthFromCellText(text) {
  const s = String(text ?? "")
  for (const [token, mo] of MONTH_TOKEN_MAP) {
    if (/^[A-Za-z]+$/.test(token)) {
      if (new RegExp(`\\b${token}\\b`, "i").test(s)) return mo
    } else if (token.includes(".") || (token.match(/[ก-ฮ]/g) ?? []).length >= 3) {
      if (s.includes(token)) return mo
    } else if (new RegExp(`(?:^|[^฀-๿])${token}(?![฀-๿])`).test(s)) {
      return mo
    }
  }
  return null
}

/** Mirrors automation/claude-analyst.js's monthYearFromText exactly. */
function monthYearFromText(text) {
  const s = String(text ?? "")
  const month = monthFromCellText(s)
  if (!month) return { month: null, beYear: null }
  return { month, beYear: resolveBeYear("", "", s) }
}

/** Mirrors automation/claude-analyst.js's monthYearFromRows exactly. */
function monthYearFromRows(rows) {
  for (const row of rows.slice(0, 15)) {
    for (const val of Object.values(row)) {
      if (val === null || val === undefined) continue
      const hit = monthYearFromText(val)
      if (hit.month) return hit
    }
  }
  return { month: null, beYear: null }
}

function resolveBeMonthFromRows(rows) {
  return monthYearFromRows(rows).month
}

/**
 * Mirrors automation/claude-analyst.js's sheetMatchScore exactly — see there
 * for what each tier means and why a contradicting sheet scores 0.
 */
function sheetMatchScore(ws, rows, targetMonth, targetYear) {
  const fromName = monthYearFromText(ws.name)
  if (fromName.month) {
    if (fromName.month !== targetMonth) return 0
    if (fromName.beYear && targetYear && fromName.beYear !== targetYear) return 0
    return fromName.beYear && targetYear ? 4 : 3
  }
  const hit = monthYearFromRows(rows)
  if (hit.month !== targetMonth) return 0
  if (hit.beYear && targetYear && hit.beYear !== targetYear) return 0
  return hit.beYear && targetYear ? 2 : 1
}


// ── Score extraction (ported from automation/claude-analyst.js) ───────────

const GRAND_TOTAL_LABELS = [
  "รวมแต้มทั้งหมด", "รวมคะแนนทั้งหมด", "รวมทั้งสิ้น", "ยอดรวมทั้งหมด",
  "รวมทั้งหมด", "คะแนนรวมทั้งหมด",
]

const SUBTOTAL_LABELS = [
  "รวมคะแนน", "รวมแต้ม", "คะแนนรวม", "ผลรวม", "รวม",
]

const TOTAL_LABELS = [...GRAND_TOTAL_LABELS, ...SUBTOTAL_LABELS]

const stripSpace = (s) => s.replace(/\s+/g, "")
const includesLabel = (text, label) => stripSpace(text).includes(stripSpace(label))

function isYearLike(n) {
  if (n >= 1900 && n <= 2099) return true
  if (n >= 2400 && n <= 2699 && Number.isInteger(n)) return true
  return false
}

function numsFromText(val, skipYearFilter = false) {
  const s = String(val ?? "").replace(/,/g, "")
  return [...s.matchAll(/\d+(?:\.\d+)?/g)]
    .map((m) => parseFloat(m[0]))
    .filter((n) => !isNaN(n) && n > 0 && (skipYearFilter || !isYearLike(n)))
}

const SUMMARY_LABEL = "(?:รวม|ผลรวม|คะแนนรวม|ยอดรวม)"
const SUMMARY_WITH_SEP = new RegExp(`${SUMMARY_LABEL}[^=:\\d]*[=:]\\s*([\\d,]+(?:\\.\\d+)?)`, "g")
const SUMMARY_BARE = new RegExp(`^${SUMMARY_LABEL}[^\\d]*?\\s+([\\d,]+(?:\\.\\d+)?)$`)

function summaryTextCandidates(rows) {
  const results = []
  for (const row of rows) {
    for (const val of Object.values(row)) {
      if (typeof val !== "string") continue
      const s = val.replace(/\s+/g, " ").trim()
      if (!s) continue

      const withSep = [...s.matchAll(SUMMARY_WITH_SEP)]
        .map((m) => parseFloat(m[1].replace(/,/g, "")))
        .filter((n) => !isNaN(n) && n > 0)
      if (withSep.length > 0) {
        results.push(...withSep)
        continue
      }

      const bare = SUMMARY_BARE.exec(s)
      if (!bare) continue
      const n = parseFloat(bare[1].replace(/,/g, ""))
      if (!isNaN(n) && n > 0 && !isYearLike(n)) results.push(n)
    }
  }
  return results
}

function toNum(val) {
  if (val === null || val === undefined || val === "") return NaN
  if (typeof val === "number") return val
  if (typeof val === "boolean") return NaN
  const s = String(val).trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return NaN
  return parseFloat(s.replace(/,/g, ""))
}

function collectCandidates(rows, skipYearFilter = false) {
  const results = []
  for (const row of rows) {
    for (const val of Object.values(row)) {
      const n = toNum(val)
      if (isNaN(n) || n <= 0) continue
      if (!skipYearFilter && isYearLike(n)) continue
      results.push(n)
    }
  }
  return results
}

const SCORE_COLUMN_LABELS = ["รวมแต้ม", "รวมคะแนน", "คะแนนรวม", "แต้มรวม"]

function findScoreColumn(rows) {
  for (const row of rows) {
    const entries = Object.entries(row)
      .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== "")
    if (entries.length < 3) continue
    if (entries.some(([, v]) => !isNaN(toNum(v)))) continue

    const hit = entries.find(([, v]) =>
      SCORE_COLUMN_LABELS.some((label) => stripSpace(String(v)) === stripSpace(label))
    )
    if (hit) return hit[0]
  }
  return null
}

function declaredScore(row, scoreCol) {
  if (!scoreCol) return NaN
  const n = toNum(row[scoreCol])
  return !isNaN(n) && n > 0 ? n : NaN
}

/** Byte-faithful port of automation/claude-analyst.js's extractScoreFromRows. */
function extractScoreFromRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { score: null, method: "no rows" }
  }

  const scoreCol = findScoreColumn(rows)

  const grandCandidates = []
  for (const row of rows) {
    const allValues = Object.values(row).map((v) => String(v ?? ""))
    const labelCells = allValues.filter((s) =>
      GRAND_TOTAL_LABELS.some((label) => includesLabel(s, label))
    )
    if (labelCells.length > 0) {
      const declared = declaredScore(row, scoreCol)
      if (!isNaN(declared)) {
        grandCandidates.push(declared)
        continue
      }
      const nonYearNums = collectCandidates([row], false)
      const nums = nonYearNums.length > 0 ? nonYearNums : collectCandidates([row], true)
      const embedded = labelCells.flatMap((s) => numsFromText(s, true))
      grandCandidates.push(...nums, ...embedded)
    }
  }
  if (grandCandidates.length > 0) {
    return { score: Math.max(...grandCandidates), method: "grand-total label row (all columns)" }
  }

  const summaryCandidates = summaryTextCandidates(rows)
  if (summaryCandidates.length > 0) {
    return { score: Math.max(...summaryCandidates), method: "free-text summary line" }
  }

  const subCandidates = []
  for (const row of rows) {
    const firstThree = ["col_1", "col_2", "col_3"].map((k) => String(row[k] ?? ""))
    const hasLabel = firstThree.some((s) =>
      SUBTOTAL_LABELS.some((label) => includesLabel(s, label))
    )
    if (hasLabel) {
      const declared = declaredScore(row, scoreCol)
      if (!isNaN(declared)) {
        subCandidates.push(declared)
        continue
      }
      const nums = collectCandidates([row])
      subCandidates.push(...nums)
    }
  }
  if (subCandidates.length > 0) {
    const subMax = Math.max(...subCandidates)
    const allNums = collectCandidates(rows)
    const sheetMax = allNums.length > 0 ? Math.max(...allNums) : subMax
    if (sheetMax > subMax) {
      return { score: sheetMax, method: "largest in sheet (exceeds sub-total label rows)" }
    }
    return { score: subMax, method: "sub-total label row (col_1-3)" }
  }

  const all = collectCandidates(rows)
  if (all.length > 0) {
    return { score: Math.max(...all), method: "largest in sheet" }
  }

  const allIncludingYearLike = collectCandidates(rows, true)
  if (allIncludingYearLike.length > 0) {
    return { score: Math.max(...allIncludingYearLike), method: "largest in sheet (year-like fallback)" }
  }

  let computedTotal = 0
  for (const row of rows) {
    const isLabel = ["col_1", "col_2", "col_3"]
      .some((k) => TOTAL_LABELS.some((label) => includesLabel(String(row[k] ?? ""), label)))
    if (isLabel) continue

    const weightRaw = row["col_3"]
    if (weightRaw === null || weightRaw === undefined) continue

    let weight
    if (typeof weightRaw === "number") {
      weight = weightRaw
    } else {
      const m = String(weightRaw).replace(/,/g, "").match(/^(\d+\.?\d*)/)
      if (!m) continue
      weight = parseFloat(m[1])
    }
    if (isNaN(weight) || weight <= 0) continue

    let daySum = 0
    for (let d = 6; d <= 36; d++) {
      const v = toNum(row[`col_${d}`])
      if (!isNaN(v) && v > 0) daySum += v
    }
    if (daySum > 0) computedTotal += weight * daySum
  }

  if (computedTotal > 0) {
    return { score: computedTotal, method: "weight × day-count computation" }
  }

  return { score: null, method: "no candidates found" }
}

const DAY_COL_RE = /^D([1-9]|[12]\d|3[01])$/

function findHeaderRow(rows) {
  for (const row of rows) {
    const vals = Object.values(row).map((v) => String(v ?? "").trim())
    if (vals.includes("แต้ม") && vals.some((v) => DAY_COL_RE.test(v))) return row
  }
  return null
}

function reconstructFromDailyCells(rows) {
  const header = findHeaderRow(rows)
  if (!header) return null

  const weightCol = Object.keys(header).find((k) => String(header[k]).trim() === "แต้ม")
  const dayCols = Object.keys(header).filter((k) => DAY_COL_RE.test(String(header[k] ?? "").trim()))
  if (!weightCol || dayCols.length === 0) return null

  let total = 0
  for (const row of rows) {
    if (row === header) continue
    const isTotalRow = Object.values(row).some((v) => TOTAL_LABELS.some((lbl) => includesLabel(String(v ?? ""), lbl)))
    if (isTotalRow) continue

    const weight = toNum(row[weightCol])
    if (isNaN(weight) || weight <= 0) continue

    const daySum = dayCols.reduce((s, k) => {
      const v = toNum(row[k])
      return !isNaN(v) && v > 0 ? s + v : s
    }, 0)
    if (daySum > 0) total += weight * daySum
  }
  return total > 0 ? total : null
}

/** Byte-faithful port of automation/claude-analyst.js's resolveScore. */
function resolveScore(rows) {
  const { score: jsScore, method: jsMethod } = extractScoreFromRows(rows)

  const grandRowEmpty = rows.some((row) => {
    const allVals = Object.values(row).map((v) => String(v ?? ""))
    const hasLabel = allVals.some((s) => GRAND_TOTAL_LABELS.some((lbl) => includesLabel(s, lbl)))
    if (!hasLabel) return false
    return !Object.values(row).some((val) => {
      const n = toNum(val)
      return !isNaN(n) && n > 0
    })
  })

  if (!grandRowEmpty) return { score: jsScore, method: jsMethod }

  const isSubtotalRow = (row) => {
    const firstThree = ["col_1", "col_2", "col_3"].map((k) => String(row[k] ?? ""))
    return firstThree.some((s) => SUBTOTAL_LABELS.some((lbl) => includesLabel(s, lbl)))
  }
  const isGrandTotalRow = (row) =>
    Object.values(row).some((v) => GRAND_TOTAL_LABELS.some((lbl) => includesLabel(String(v ?? ""), lbl)))

  const rowNums = (row) =>
    Object.values(row).map(toNum).filter((n) => !isNaN(n) && n > 0 && !isYearLike(n))

  const populated = rows.filter((r) => isSubtotalRow(r) && rowNums(r).length > 0)
  const empty = rows.filter((r) => isSubtotalRow(r) && rowNums(r).length === 0)

  const subtotalSum = populated.reduce((s, r) => s + Math.max(...rowNums(r)), 0)

  let dataRowSum = 0
  if (populated.length > 0 && empty.length > 0) {
    let scoreColIndex = -1
    for (const row of populated) {
      const indices = Object.keys(row)
        .filter((k) => /^col_\d+$/.test(k) && !isNaN(toNum(row[k])) && toNum(row[k]) > 0)
        .map((k) => parseInt(k.slice(4)))
      if (indices.length > 0) scoreColIndex = Math.max(scoreColIndex, Math.max(...indices))
    }
    if (scoreColIndex > 0) {
      const scoreColKey = `col_${scoreColIndex}`
      for (const row of rows) {
        if (isSubtotalRow(row) || isGrandTotalRow(row)) continue
        const n = toNum(row[scoreColKey])
        if (!isNaN(n) && n > 0 && !isYearLike(n)) dataRowSum += n
      }
    }
  }

  const candidates = [
    { value: subtotalSum, method: "sum of sub-total rows (grand-total formula uncached)" },
    { value: dataRowSum, method: "sum of score-column data rows (sub-totals partially uncached)" },
    { value: reconstructFromDailyCells(rows) ?? 0, method: "reconstructed from daily cells × rate (sub-totals also uncached)" },
  ]
  const best = candidates.reduce((a, b) => (b.value > a.value ? b : a))

  if (best.value > 0 && best.value > (jsScore ?? 0)) {
    return { score: best.value, method: best.method }
  }

  return { score: jsScore, method: jsMethod }
}

// Per UPLOAD_VIA_LINE_DESIGN.md §7.7 rec 1: the synchronous path only trusts
// resolveScore() when it landed on a declared grand-total/free-text label —
// the case where the workbook itself states the number. Every other method
// string (sub-total sums, "largest in sheet", the uncached-formula fallback
// tiers) is low-confidence and must go through the queued/Claude path.
const HIGH_CONFIDENCE_METHODS = new Set([
  "grand-total label row (all columns)",
  "free-text summary line",
])

function isHighConfidence(method) {
  return HIGH_CONFIDENCE_METHODS.has(method)
}

// ── Zip-entry / uncompressed-size guard (§7.7 rec 3, §11) ──────────────────
//
// A .xlsx is a zip. Before handing untrusted bytes to ExcelJS, walk the zip's
// own central directory (no decompression — just reading declared entry
// count and per-entry uncompressed-size fields) and reject anything with too
// many entries or too large a declared uncompressed size. §11 says to do
// this "with the JSZip dependency the pipeline already has" — true of
// automation/, which already depends on it, but NOT of the root build (C8,
// §7.7 rec 4: only `exceljs` is conceded into the root package.json). So
// this is a small hand-rolled ZIP central-directory reader instead of a new
// root dependency — the format is public and stable (APPNOTE.TXT), and all
// this needs is fixed-width integer fields, not real decompression.
const ZIP_EOCD_SIGNATURE = 0x06054b50
const ZIP_CENTRAL_DIR_SIGNATURE = 0x02014b50
const DEFAULT_MAX_ZIP_ENTRIES = 200
const DEFAULT_MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024

function findEndOfCentralDirectory(buf) {
  // EOCD is 22 bytes plus an optional comment of up to 65535 bytes — scan
  // backward from the end for the signature rather than assuming a fixed
  // offset.
  const minPos = Math.max(0, buf.length - 22 - 65535)
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === ZIP_EOCD_SIGNATURE) return i
  }
  return -1
}

/**
 * Throws with a `.code` on any violation; returns `{ entryCount,
 * uncompressedBytes }` when the archive is within bounds.
 */
function checkZipSafety(buf, opts = {}) {
  const maxEntries = opts.maxEntries || DEFAULT_MAX_ZIP_ENTRIES
  const maxUncompressed = opts.maxUncompressedBytes || DEFAULT_MAX_UNCOMPRESSED_BYTES

  const eocdPos = findEndOfCentralDirectory(buf)
  if (eocdPos === -1) {
    const err = new Error("not a valid zip/xlsx archive")
    err.code = "NOT_A_ZIP"
    throw err
  }

  const totalEntries = buf.readUInt16LE(eocdPos + 10)
  const cdSize = buf.readUInt32LE(eocdPos + 12)
  const cdOffset = buf.readUInt32LE(eocdPos + 16)

  if (totalEntries > maxEntries) {
    const err = new Error(`too many zip entries: ${totalEntries} > ${maxEntries}`)
    err.code = "ZIP_TOO_MANY_ENTRIES"
    throw err
  }

  let pos = cdOffset
  let seen = 0
  let uncompressedTotal = 0
  const cdEnd = cdOffset + cdSize

  while (pos < cdEnd && pos + 46 <= buf.length && seen < totalEntries) {
    const sig = buf.readUInt32LE(pos)
    if (sig !== ZIP_CENTRAL_DIR_SIGNATURE) break

    const uncompressedSize = buf.readUInt32LE(pos + 24)
    const nameLen = buf.readUInt16LE(pos + 28)
    const extraLen = buf.readUInt16LE(pos + 30)
    const commentLen = buf.readUInt16LE(pos + 32)

    // 0xFFFFFFFF marks a ZIP64 entry (real size lives in the extra field).
    // A genuine xlsx this small (bucket cap 5 MB) never needs ZIP64 — treat
    // it as suspicious rather than parse the extra field.
    if (uncompressedSize === 0xffffffff) {
      const err = new Error("zip64 entries are not supported")
      err.code = "ZIP64_UNSUPPORTED"
      throw err
    }

    uncompressedTotal += uncompressedSize
    if (uncompressedTotal > maxUncompressed) {
      const err = new Error(`uncompressed size exceeds ${maxUncompressed} bytes`)
      err.code = "ZIP_TOO_LARGE"
      throw err
    }

    pos += 46 + nameLen + extraLen + commentLen
    seen += 1
  }

  if (seen !== totalEntries) {
    const err = new Error("zip central directory is malformed")
    err.code = "ZIP_MALFORMED"
    throw err
  }

  return { entryCount: seen, uncompressedBytes: uncompressedTotal }
}

// ── Workbook -> rows (ExcelJS), with a parse timeout ───────────────────────

function nonNullCount(ws) {
  let count = 0
  ws.eachRow((row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (cell.value !== null && cell.value !== undefined) count++
    })
  })
  return count
}

function rowsFromWorksheet(ws) {
  const rows = []
  ws.eachRow((row) => {
    if (!row.hasValues) return
    const obj = {}
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const key = "col_" + colNumber
      const val = cell.value
      const isMasterFormula = val !== null && typeof val === "object" && "formula" in val
      const isCloneFormula = val !== null && typeof val === "object" && "sharedFormula" in val && !("formula" in val)
      if (isMasterFormula || isCloneFormula) {
        const r = cell.result
        if (isCloneFormula) {
          obj[key] = typeof r === "number" ? r : null
        } else if (r === null || r === undefined) {
          obj[key] = null
        } else if (r instanceof Date) {
          obj[key] = r.toISOString()
        } else {
          obj[key] = r
        }
        return
      }
      if (val === null || val === undefined) obj[key] = null
      else if (val instanceof Date) obj[key] = val.toISOString()
      else if (typeof val === "object" && Array.isArray(val.richText)) obj[key] = val.richText.map((r) => r.text || "").join("")
      else if (typeof val === "object" && "text" in val) obj[key] = String(val.text || "")
      else obj[key] = val
    })
    if (Object.keys(obj).length) rows.push(obj)
  })
  return rows
}

/**
 * Buffer -> { rows, sheetName, sheetCount }. Lazy-`require`s exceljs so
 * merely requiring this module (e.g. by a future test) never pulls it in —
 * only actually parsing a workbook does (§7.7 rec 4).
 */
async function parseWorkbookRows(buffer, opts = {}) {
  const ExcelJS = require("exceljs")
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)

  const sheets = workbook.worksheets
  if (sheets.length === 0) throw new Error("Workbook has no sheets.")

  let idx = 0
  if (nonNullCount(sheets[0]) < 3 && sheets.length > 1) idx = 1

  // Which sheet is the month the physician picked? Tab names answer when
  // they say anything, but a workbook whose tabs are "Sheet1"/"Sheet2" still
  // usually writes the month in a title row, so every candidate sheet's
  // content gets read too rather than falling straight back to position.
  // The year matters as much as the month here: a physician who keeps every
  // month of every year in one file has more than one "July".
  //
  // Every sheet is scored, single-sheet workbooks included, because the
  // caller needs `matched` to mean "this file identified itself as the month
  // asked for" — not "there was more than one sheet and one of them did".
  const targetMonth = opts.targetMonth || null
  const targetYear = opts.targetYear || null
  let matched = false
  if (targetMonth) {
    let bestScore = 0
    sheets.forEach((ws, i) => {
      if (nonNullCount(ws) < 3) return
      const s = sheetMatchScore(ws, rowsFromWorksheet(ws), targetMonth, targetYear)
      if (s > bestScore) {
        bestScore = s
        idx = i
      }
    })
    matched = bestScore > 0
  }

  const ws = sheets[idx]
  return { rows: rowsFromWorksheet(ws), sheetName: ws.name, sheetCount: sheets.length, matched }
}

/**
 * Runs the zip guard, then `parseWorkbookRows` raced against `timeoutMs`
 * (§7.7 rec 3: a file that passes the entry/size guard can still cost CPU
 * rather than memory — the guard bounds the input, the timeout bounds the
 * work). On timeout, rejects with `err.code === "PARSE_TIMEOUT"` so the
 * caller can fail closed to the queue rather than hold the request open.
 */
async function parseWorkbookRowsSafely(buffer, opts = {}) {
  checkZipSafety(buffer, opts)

  const timeoutMs = opts.timeoutMs || 7000
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`workbook parse exceeded ${timeoutMs}ms`)
      err.code = "PARSE_TIMEOUT"
      reject(err)
    }, timeoutMs)
  })

  try {
    return await Promise.race([parseWorkbookRows(buffer, opts), timeout])
  } finally {
    clearTimeout(timer)
  }
}

module.exports = {
  resolveBeYear,
  resolveBeYearFromRows,
  resolveBeMonth,
  resolveBeMonthFromRows,
  monthFromCellText,
  monthYearFromText,
  monthYearFromRows,
  sheetMatchScore,
  extractScoreFromRows,
  resolveScore,
  isHighConfidence,
  HIGH_CONFIDENCE_METHODS,
  checkZipSafety,
  parseWorkbookRows,
  parseWorkbookRowsSafely,
}
