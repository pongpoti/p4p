/**
 * index.js
 *
 * - Fetches up to 10 new unread inbox messages
 * - For .xlsx attachments: converts the FIRST sheet to JSON using ExcelJS
 * - Sends to Claude API to extract: physician name, workload date (BE), total score
 * - Fuzzy-matches name in Supabase, saves score, notifies via Telegram
 *
 *   npm start
 */

import "./redact.js";   // MUST be first: patches console before anything logs (public job logs)

import { createGmailClient }             from "./gmail-client.js";
import { createDriveClient }             from "./drive-client.js";
import { analyseJson, resolveBeMonth, resolveBeMonthFromRows, resolveBeYear, resolveBeYearByPriority, resolveBeYearFromRows, resolvePhysicianNameCandidates, resolvePhysicianNameFromSheet, periodsInText, sheetMatchScore, statedPeriods } from "./claude-analyst.js";
import { matchName, saveScore, logSubmission, bumpSenderMatch, getRosterRowByIndex } from "./supabase-client.js";
import { sendTelegram, formatResultMessage, formatErrorMessage } from "./telegram.js";
import { buildHtmlReply }               from "./templates/reply.js";
import { buildHtmlErrorReply }          from "./templates/error-reply.js";
import { checkEnv }                     from "./env-check.js";
import { MAX_MESSAGES, SKIP_SENDERS, SEND_ERROR_REPLIES, THREAD_RELAY_SENDERS, MAX_ATTACHMENT_SIZE_BYTES } from "./config.js";
import log                              from "./logger.js";
import * as path                        from "path";
import { pathToFileURL }                from "url";
import ExcelJS                          from "exceljs";
// override:true ensures .env values win over stale system-level env vars
// (e.g. ANTHROPIC_API_KEY="" set at OS level would otherwise shadow the real key)
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ override: true });

// Thai month names for auto-reply display (index 0 unused; 1 = January … 12 = December)
const THAI_MONTHS = [
  "", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน",
  "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม",
  "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
];

/** "2569_07" -> "กรกฎาคม 2569". Falls back to the raw key if it is not one. */
function displayMonthKey(key) {
  const [beYear, monthNum] = String(key ?? "").split("_");
  const thaiMonth = THAI_MONTHS[parseInt(monthNum, 10)];
  return thaiMonth ? `${thaiMonth} ${beYear}` : String(key ?? "");
}

// Lazy Drive client — only initialised if P4P_FOLDER_ID is set
let _drive = null;
function getDrive() {
  if (!process.env.P4P_FOLDER_ID) return null;
  if (!_drive) _drive = createDriveClient();
  return _drive;
}

// MIME types AND extensions that we treat as Excel files (.xlsx only)
const EXCEL_MIMETYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/wps-office.xlsx",                                         // WPS variant
]);

// Matches cloud-storage share links — used to detect "file link instead of real file"
const CLOUD_LINK_RE = /https?:\/\/(drive\.google\.com|docs\.google\.com|1drv\.ms|dropbox\.com|onedrive\.live\.com|sharepoint\.com)/i;

function isExcelFile(mimeType, filename) {
  if (EXCEL_MIMETYPES.has(mimeType)) return true;
  if (!filename) return false;
  return path.extname(filename).toLowerCase() === ".xlsx";
}

// Excel creates a hidden "~$<name>.xlsx" lock/owner file next to any workbook
// that's still open on the sender's machine — a few hundred bytes, not a real
// zip/xlsx. Mail clients or folder syncs sometimes attach it alongside (or
// instead of) the real file, which otherwise surfaces as a confusing "Can't
// find end of central directory" parse error deep in the pipeline.
function isOfficeLockFile(filename) {
  return typeof filename === "string" && path.basename(filename).startsWith("~$");
}

function formatSize(bytes) {
  if (bytes < 1024)    return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

// ── Excel loading ─────────────────────────────────────────────────────────
// Note: both ExcelJS and JSZip are intentionally used together.
//   • JSZip  — low-level ZIP/XML manipulation to strip formulas and extract
//              a single sheet without re-encoding the whole workbook.
//   • ExcelJS — high-level row/cell reading after the XML has been sanitised.
// Replacing either library would require reimplementing the other's role.

/**
 * Load any Excel buffer with ExcelJS and convert the correct sheet to row objects.
 *
 * Uses row.eachCell (not row.values) so we access the real Cell object and can
 * call cell.result directly. This fixes cm="1" (Excel 365 dynamic array formula)
 * cells where row.values returns a formula-object with result=0 even when the
 * actual cached <v> element contains the correct non-zero value.
 *
 * @param {Buffer} buffer
 * @param {{ targetMonth?: number|null }} [opts]  targetMonth 1–12 hints which sheet to use
 *   in multi-sheet workbooks (e.g. physician accumulated all months in one file).
 */
async function firstSheetToRows(buffer, { targetMonth = null, targetYear = null } = {}) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const allSheets = workbook.worksheets.map((ws) => ws.name);
  if (allSheets.length === 0) throw new Error("Workbook has no sheets.");

  function nonNullCount(ws) {
    let count = 0;
    ws.eachRow((row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (cell.value !== null && cell.value !== undefined) count++;
      });
    });
    return count;
  }

  // ── Sheet selection ──────────────────────────────────────────────────────
  // Default: first non-empty sheet (existing behaviour).
  // When targetMonth is known, prefer the sheet whose name contains a month
  // token matching that month number — handles multi-month workbooks where a
  // physician accumulates all months in one file.
  let wsIndex = 0;
  if (nonNullCount(workbook.worksheets[0]) < 3 && workbook.worksheets.length > 1) {
    wsIndex = 1;
  }

  // Scored rather than first-name-wins: tab names answer when they say
  // anything, but a workbook whose tabs are "Sheet1"/"Sheet2" still usually
  // writes the month in a title row, so candidate sheets get read too. The
  // year counts as much as the month — a physician who keeps every month of
  // every year in one file has more than one "July". See sheetMatchScore.
  // Single-sheet workbooks are scored too, so `matched` means "this file
  // identified itself as the month asked for" rather than "there were
  // several sheets and one of them did".
  let matched = false;
  if (targetMonth !== null) {
    const defaultIndex = wsIndex;
    let bestScore = 0;
    workbook.worksheets.forEach((ws, i) => {
      if (nonNullCount(ws) < 3) return;
      const s = sheetMatchScore(ws, rowsOfSheet(ws), targetMonth, targetYear);
      if (s > bestScore) {
        bestScore = s;
        wsIndex = i;
      }
    });
    matched = bestScore > 0;
    if (bestScore > 0 && wsIndex !== defaultIndex) {
      console.log(`│        📋  Multi-sheet workbook: target ${targetMonth}/${targetYear ?? "?"} → sheet "${workbook.worksheets[wsIndex].name}" (index ${wsIndex}, match ${bestScore}) over default "${allSheets[defaultIndex]}"`);
    }
  }

  const worksheet = workbook.worksheets[wsIndex];
  return { rows: rowsOfSheet(worksheet), allSheets, chosenSheet: allSheets[wsIndex], matched };
}

/** One worksheet -> the col_N row objects the extractor and Claude expect. */
function rowsOfSheet(worksheet) {
  const rows = [];

  worksheet.eachRow((row) => {
    if (!row.hasValues) return;

    const obj = {};

    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const key = `col_${colNumber}`;

      const val = cell.value;
      // ExcelJS represents shared-formula cells in two forms:
      //   Master cell: { formula: "=A1*B1", result: 42, shared: true, si: 0 }  → "formula" in val
      //   Clone cell:  { sharedFormula: "A1", result: 42 }                      → "sharedFormula" in val, no "formula"
      // Without handling clones, their raw objects leak into rows as { sharedFormula: "..." }
      // which bloats the JSON and prevents correct numeric extraction.
      const isMasterFormula = val !== null && typeof val === "object" && "formula" in val;
      const isCloneFormula  = val !== null && typeof val === "object" && "sharedFormula" in val && !("formula" in val);

      if (isMasterFormula || isCloneFormula) {
        const r = cell.result;
        if (isCloneFormula) {
          // Clone cells: keep only numeric results (computed scores/counts).
          // Text results are repeated merged-cell display text that adds no analytical value
          // and would be duplicated across every column in the merged range.
          obj[key] = (typeof r === "number") ? r : null;
        } else {
          // Master formula cells: extract result normally
          if (r === null || r === undefined) {
            obj[key] = null;
          } else if (r instanceof Date) {
            obj[key] = r.toISOString();
          } else {
            obj[key] = r;
          }
        }
        return;
      }

      if (val === null || val === undefined) {
        obj[key] = null;
      } else if (val instanceof Date) {
        obj[key] = val.toISOString();
      } else if (typeof val === "object" && Array.isArray(val.richText)) {
        obj[key] = val.richText.map((r) => r.text ?? "").join("");
      } else if (typeof val === "object" && "text" in val) {
        obj[key] = String(val.text ?? "");
      } else {
        obj[key] = val;
      }
    });

    if (Object.keys(obj).length > 0) rows.push(obj);
  });

  return rows;
}

/**
 * Pre-process an xlsx buffer at the XML level, replacing every formula cell
 * with its plain cached value. This prevents ExcelJS from choking on:
 *   - Shared formulas (t="shared"): master/clone chains that ExcelJS
 *     can't reconstruct correctly when writing a stripped workbook.
 *   - Dynamic array formulas (cm="1"): Excel 365 spill formulas that
 *     ExcelJS reads as result=0.
 *
 * Strategy: for each worksheet XML, strip the <f> element from every cell
 * and keep only the <v> element (the cached computed value).
 * Returns a new Buffer with the modified XML.
 */
async function stripFormulasFromBuffer(inputBuffer) {
  const JSZip = (await import("jszip")).default;
  const zip   = await JSZip.loadAsync(inputBuffer);

  const sheetPaths = Object.keys(zip.files).filter(
    (p) => p.startsWith("xl/worksheets/sheet") && p.endsWith(".xml")
  );

  for (const sheetPath of sheetPaths) {
    let xml = await zip.files[sheetPath].async("string");

    // Normalize bare \r line endings to \n.
    // Some Excel files (notably from Mac Excel) use \r without \n between
    // the XML declaration and the root element. JSZip's internal XML parser
    // treats \r as a document separator, triggering "documents may contain
    // only one root" when the zip is re-serialised via generateAsync.
    xml = xml.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    // Match only non-self-closing cells: <c ...>...</c>
    // The negative lookbehind (?<!\/) ensures we never match <c .../>
    // (self-closing cells have no formula/value to strip and must pass through unchanged)
    xml = xml.replace(/<c ([^>]*)(?<!\/)>([\s\S]*?)<\/c>/g, (match, attrs, inner) => {
      // Remove cm="1" attribute (dynamic array marker) from <c> tag
      const cleanAttrs = attrs.replace(/\s*cm="1"/, "");

      // Extract cached value from <v>...</v> (allow optional whitespace in tag, e.g. <v >)
      const vMatch = inner.match(/<v[^>]*>([^<]*)<\/v>/);
      const vTag   = vMatch ? `<v>${vMatch[1]}</v>` : "";

      // Reconstruct cell with no formula, just the cached value
      return vTag ? `<c ${cleanAttrs}>${vTag}</c>` : `<c ${cleanAttrs}/>`;
    });

    zip.file(sheetPath, xml);
  }

  const out = await zip.generateAsync({
    type              : "nodebuffer",
    compression       : "DEFLATE",
    compressionOptions: { level: 6 },
  });

  return out;
}

/**
 * Extract the target sheet from the ORIGINAL buffer and return it as a
 * single-sheet xlsx, preserving all original formulas and formatting.
 *
 * Strategy:
 *   1. Use the formula-stripped buffer to safely determine which sheet has
 *      content (ExcelJS can't reliably read shared-formula files otherwise).
 *   2. Map the chosen sheet index back to its raw XML path in the original zip.
 *   3. Build a new minimal xlsx zip using only that sheet's original XML,
 *      carrying over all shared resources (styles, sharedStrings, theme, etc.)
 *      but removing references to the other sheets from workbook.xml.
 *
 * Returns a Buffer, or null if no usable sheet is found.
 */
export async function extractFirstSheetBuffer(buffer) {
  const JSZip = (await import("jszip")).default;

  // ── Step 1: determine which sheet index to use (0-based) ──────────────
  const strippedBuffer = await stripFormulasFromBuffer(buffer);
  const source = new ExcelJS.Workbook();
  await source.xlsx.load(strippedBuffer);

  if (source.worksheets.length === 0) return null;

  function nonNullCount(ws) {
    let count = 0;
    ws.eachRow((row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (cell.value !== null && cell.value !== undefined) count++;
      });
    });
    return count;
  }

  let sheetIndex = 0;
  const firstCount = nonNullCount(source.worksheets[0]);

  if (firstCount < 3 && source.worksheets.length > 1) {
    const secondCount = nonNullCount(source.worksheets[1]);
    console.log(`│        ℹ️   First sheet "${source.worksheets[0].name}" has ${firstCount} cell(s) — using sheet 2 "${source.worksheets[1].name}" (${secondCount} cells) for upload.`);
    if (secondCount < 3) {
      console.warn(`│        ⚠️  Second sheet also almost blank — upload aborted.`);
      return null;
    }
    sheetIndex = 1;
  }

  if (nonNullCount(source.worksheets[sheetIndex]) < 3) return null;

  // ── Step 2: transplant original sheet XML into a new single-sheet zip ──
  const origZip = await JSZip.loadAsync(buffer);

  // Resolve the correct sheet XML file via workbook.xml + rels.
  // Sorting sheetN.xml filenames by number is NOT reliable — Excel can reorder
  // sheets visually without renumbering the underlying XML files, so
  // sheetPaths[sheetIndex] can point to the wrong sheet in reordered workbooks.
  const wbXml   = await origZip.files["xl/workbook.xml"].async("string");
  const relsXml = await origZip.files["xl/_rels/workbook.xml.rels"].async("string");

  const sheetsBlockM = wbXml.match(/<sheets>([\s\S]*?)<\/sheets>/);
  if (!sheetsBlockM) return null;

  // r:id values for each sheet in visual order (as listed in workbook.xml)
  const sheetRIds = [...sheetsBlockM[1].matchAll(/r:id="([^"]+)"/g)].map((m) => m[1]);
  if (sheetIndex >= sheetRIds.length) return null;

  const targetRId = sheetRIds[sheetIndex];
  const relM = relsXml.match(new RegExp(`Id="${targetRId}"[^>]+Target="([^"]+)"`));
  if (!relM) return null;

  const targetRelPath   = relM[1];               // e.g. "worksheets/sheet2.xml"
  const targetSheetPath = `xl/${targetRelPath}`; // e.g. "xl/worksheets/sheet2.xml"
  const sheetNumM       = targetRelPath.match(/sheet(\d+)\.xml$/i);
  if (!sheetNumM) return null;
  const targetSheetNum  = parseInt(sheetNumM[1]); // 1-based, for internal XML references

  // Build output zip: copy everything except the other sheet XMLs and their rels
  const outZip = new JSZip();

  for (const [filePath, fileObj] of Object.entries(origZip.files)) {
    if (fileObj.dir) continue;

    // Drop worksheets other than our target
    if (/^xl\/worksheets\/sheet\d+\.xml$/.test(filePath) && filePath !== targetSheetPath) continue;
    if (/^xl\/worksheets\/_rels\/sheet\d+\.xml\.rels$/.test(filePath)) {
      const num = parseInt(filePath.match(/sheet(\d+)/)[1]);
      if (num !== targetSheetNum) continue;
    }

    // Rewrite workbook.xml to reference only the chosen sheet
    if (filePath === "xl/workbook.xml") {
      let wbXml = await fileObj.async("string");
      // Keep only the target <sheet> element; renumber it as sheet 1
      wbXml = wbXml.replace(/<sheets>[\s\S]*?<\/sheets>/, (sheetsBlock) => {
        const sheetMatches = [...sheetsBlock.matchAll(/<sheet [^/]*/g)];
        if (sheetMatches.length <= sheetIndex) return sheetsBlock; // safety
        let targetTag = sheetMatches[sheetIndex][0];
        // Renumber r:id to rId1 and sheetId to 1
        targetTag = targetTag
          .replace(/r:id="[^"]*"/, 'r:id="rId1"')
          .replace(/sheetId="[^"]*"/, 'sheetId="1"');
        return `<sheets>${targetTag}/></sheets>`;
      });
      outZip.file(filePath, wbXml);
      continue;
    }

    // Rewrite workbook.xml.rels to keep only the target sheet relationship
    if (filePath === "xl/_rels/workbook.xml.rels") {
      let relsXml = await fileObj.async("string");
      // Find the rId that pointed to the target sheet
      const targetRel = new RegExp(
        `<Relationship[^>]+Id="([^"]+)"[^>]+Target="worksheets/sheet${targetSheetNum}\\.xml"[^>]*/>`
      );
      const m = relsXml.match(targetRel);
      if (m) {
        const origRid = m[1];
        // Keep only this relationship, renamed to rId1
        relsXml = relsXml.replace(
          /<Relationships[^>]*>([\s\S]*?)<\/Relationships>/,
          (_, inner) => {
            const kept = inner
              .split(/(?=<Relationship)/)
              .find((rel) => rel.includes(`Id="${origRid}"`)) ?? "";
            const renumbered = kept
              .replace(`Id="${origRid}"`, 'Id="rId1"')
              .replace(`Target="worksheets/sheet${targetSheetNum}.xml"`, 'Target="worksheets/sheet1.xml"');
            return `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${renumbered}</Relationships>`;
          }
        );
      }
      outZip.file(filePath, relsXml);
      continue;
    }

    // Rename target sheet XML to sheet1.xml in the output
    const outPath = filePath === targetSheetPath
      ? "xl/worksheets/sheet1.xml"
      : filePath.replace(`sheet${targetSheetNum}.xml`, "sheet1.xml");

    const data = await fileObj.async("nodebuffer");
    outZip.file(outPath, data);
  }

  const out = await outZip.generateAsync({
    type              : "nodebuffer",
    compression       : "DEFLATE",
    compressionOptions: { level: 6 },
  });

  return out;
}

// ── Alert reply helper ────────────────────────────────────────────────────

const ALERT_SUBJECTS = {
  wrong_extension     : "[แจ้งข้อผิดพลาด] ประเภทไฟล์ไม่ถูกต้อง",
  file_link           : "[แจ้งข้อผิดพลาด] ตรวจพบลิงก์ไฟล์แทนไฟล์จริง",
  temp_file           : "[แจ้งข้อผิดพลาด] ตรวจพบไฟล์ชั่วคราวของ Excel แทนไฟล์จริง",
  zero_score          : "[แจ้งข้อผิดพลาด] คะแนนรวมเป็นศูนย์",
  wrong_date          : "[แจ้งข้อผิดพลาด] วันที่/เดือน/ปีในไฟล์ไม่ถูกต้อง",
  physician_not_found : "[แจ้งข้อผิดพลาด] ไม่พบชื่อแพทย์ในระบบ",
  month_mismatch      : "[แจ้งข้อผิดพลาด] เดือนที่ระบุไม่ตรงกับไฟล์",
  no_period           : "[แจ้งข้อผิดพลาด] ไม่ได้ระบุเดือนที่ส่ง",
  ambiguous_period    : "[แจ้งข้อผิดพลาด] ระบุหลายเดือนในอีเมลเดียว",
  other           : "[แจ้งข้อผิดพลาด] ไม่สามารถประมวลผลไฟล์ P4P ได้",
};

/**
 * Send an alert-themed HTML reply to the original sender.
 * Silently no-ops if replyTo or messageId is missing.
 *
 * @param {"wrong_extension"|"file_link"|"temp_file"|"wrong_date"|"physician_not_found"|"other"} errorType
 * @param {string} safeFilename   HTML-escaped filename (may be empty)
 * @param {string} [detectedDate] Shown for wrong_date errors
 * @param {string} [detectedName] Shown for physician_not_found errors
 * @param {string} replyTo        Sender email address
 * @param {string} messageId      Gmail message ID for thread reply
 * @param {object} gmail          Shared Gmail client
 */
async function sendAlertReply({ errorType = "other", safeFilename = "", detectedDate = "", detectedName = "", statedDate = "", replyTo, messageId, gmail }) {
  if (!SEND_ERROR_REPLIES) {
    console.log(`│        ⏸️   Alert reply [${errorType}] suppressed (SEND_ERROR_REPLIES=false)`);
    return;
  }
  if (!replyTo || !messageId) return;
  const subject  = ALERT_SUBJECTS[errorType] ?? ALERT_SUBJECTS.other;
  const htmlReply = buildHtmlErrorReply({ safeFilename, errorType, detectedDate, detectedName, statedDate });
  try {
    await gmail.sendMessage({
      to              : replyTo,
      subject,
      html            : htmlReply,
      body            : `เรียนผู้ส่ง\n\nระบบไม่สามารถประมวลผลไฟล์ P4P ที่ท่านส่งมาได้\nกรุณาตรวจสอบและส่งใหม่อีกครั้ง`,
      replyToMessageId: messageId,
    });
    console.log(`│        📧  Alert reply [${errorType}] sent to ${replyTo}`);
  } catch (replyErr) {
    console.error(`│        ❌  Alert reply failed: ${replyErr.message}`);
  }
}

// ── Processing pipeline ───────────────────────────────────────────────────

/**
 * Process a single xlsx buffer through Claude → Supabase → Telegram → Drive.
 * Returns true if the full pipeline completed (Claude succeeded), false otherwise.
 *
 * ONE pipeline, two callers. The email path (identity === null) behaves
 * exactly as it always has, byte for byte. The LINE-upload path
 * (UPLOAD_VIA_LINE_DESIGN.md §7.1) passes an already-verified identity and an
 * already-chosen month, so the three things that are only true of email —
 * identity from name resolution, month from filename/subject/body, feedback
 * as a Gmail reply — become parameters instead of assumptions. This is a
 * seam, not a fork: a second copy of the pipeline for uploads is the exact
 * mistake automation/excel-parse.js's header documents, at ten times the size.
 *
 * @param {Buffer} buffer
 * @param {object} context
 * @param {string} context.subject
 * @param {string} context.body
 * @param {string} context.filename
 * @param {string} context.replyTo      Sender email address for auto-reply
 * @param {string} context.messageId    Gmail message ID for thread reply
 * @param {object} context.gmail        Shared Gmail client instance
 * @param {"email"|"line-upload"} [context.source]
 * @param {null|{email,fullName,department,rosterIndex,lineUserId,attempt}} [context.identity]
 *   Set → the physician is already known (verified session); Claude's name
 *   output becomes a cross-check, never a routing decision.
 * @param {null|string} [context.monthKey]  "2569_06" — set → routing skips
 *   month inference, but the file's own month is still computed and compared.
 * @param {null|{ok,fail}} [context.notify]  Replaces the inline Gmail replies
 *   when identity is set. The pipeline stops knowing which channel it is.
 */
export async function processBuffer(buffer, { subject = "", body = "", filename, replyTo = "", senderDisplayName = "", messageId = "", emailDate = null, threadId = null, gmail, source = "email", identity = null, monthKey = null, notify = null, workbookCount = 1 }) {
  const isUpload = identity !== null;

  // Telegram context for the upload path — the admin's question changes from
  // "did the fuzzy match pick the right person?" to "did the file agree with
  // what the physician claimed?" (§7.6). Null on the email path, which prints
  // its own fixed "Email" source instead of this block.
  const uploadCtx = isUpload
    ? {
        source      : source === "line-upload" ? "LINE upload" : source,
        accountName : identity.fullName ?? "",
        email       : identity.email ?? "",
        monthKey,
        rosterMatch : identity.rosterIndex != null ? "exact" : null,
        nameInFile  : null,   // filled in after Claude has read the sheet
        monthInFile : null,
        attempt     : identity.attempt ?? null,
        maxAttempts : 3,
      }
    : null;
  const tgError = (extra) => (uploadCtx ? { ...uploadCtx, ...extra } : null);

  /**
   * One failure channel for both callers: a Gmail alert reply on the email
   * path, notify.fail() on the upload path (which pushes a LINE bubble and
   * writes the queue row's error_type).
   */
  // sendAlertReply -> buildHtmlErrorReply now escapes safeFilename/detectedDate/
  // detectedName internally (single escaping point) — pass raw values below,
  // not pre-escaped ones, to avoid double-escaping ("&" -> "&amp;amp;").
  const notifyFailure = async (errorType = "other", { detail = "", detectedDate = "", detectedName = "", statedDate = "" } = {}) => {
    if (isUpload) {
      if (notify?.fail) await notify.fail(errorType, detail || detectedDate || detectedName || "");
      return;
    }
    await sendAlertReply({
      errorType,
      safeFilename: filename ?? "",
      detectedDate, detectedName, statedDate,
      replyTo, messageId, gmail,
    });
  };
  const otherReply = (detail = "") => notifyFailure("other", { detail });

  // The period this submission is FOR, on the email path, in the stated
  // order of authority: what the sender wrote (subject, then body), and only
  // then the filename. resolveBeMonth already reads its sources in that
  // order; resolveBeYear does not — it takes the best match across all three
  // per year-format tier — so the year is asked source by source instead.
  //
  // emailDate is deliberately NOT part of this: it says when the mail was
  // sent, not which month it covers, and a December report sent in January
  // would route a year wrong. It stays a last resort for sheet selection
  // below, where guessing wrong only costs a fallback rather than a score in
  // the wrong table.
  // A submission has to SAY which month it is for. The workbook's own contents
  // are never enough on their own: a physician who keeps every month in one
  // file has no way of telling us which of them this send is about, and
  // guessing on their behalf is how one month's work ends up filed as
  // another's. Three rules, all email-path only — the LIFF page asks for the
  // month up front, so monthKey is already an explicit answer.
  let routingMonth = null;
  let routingYear = null;
  if (!monthKey) {
    const { periods } = statedPeriods(filename ?? "", subject, body);

    if (periods.length === 0) {
      const detail = "ไม่พบเดือนที่ระบุในอีเมลหรือชื่อไฟล์ กรุณาระบุเดือนที่ต้องการส่ง เช่น \"ส่ง P4P เดือน ก.ค. 2569\"";
      console.error(`│        ❌  no_period: nothing in subject, body or filename names a month`);
      await sendTelegram(formatErrorMessage(detail, filename, tgError({ errorType: "no_period" })))
        .catch((e) => console.warn(`│        ⚠️  Telegram notify failed: ${e.message}`));
      await notifyFailure("no_period", { detail });
      return "rejected";
    }

    if (periods.length > 1) {
      const named = periods.map((p) => `${p.beYear ?? "?"}_${String(p.month).padStart(2, "0")}`).join(", ");
      // More than one period named, and one workbook: nothing says which of
      // them this file is. With several workbooks the send can still be
      // honoured, but only if each file names its own period — its filename is
      // the only per-file signal there is, since matching by contents is the
      // very guess these rules exist to avoid.
      const ownPeriods = workbookCount > 1 ? periodsInText(filename ?? "") : [];
      if (ownPeriods.length !== 1) {
        const detail = workbookCount > 1
          ? `อีเมลระบุหลายเดือน (${named}) กรุณาตั้งชื่อไฟล์ให้ระบุเดือนของแต่ละไฟล์ เช่น "P4P ก.ค. 2569.xlsx"`
          : `อีเมลระบุหลายเดือน (${named}) แต่แนบไฟล์มาไฟล์เดียว กรุณาส่งแยกอีเมลละหนึ่งเดือน`;
        console.error(`│        ❌  ambiguous_period: ${named} across ${workbookCount} workbook(s)`);
        await sendTelegram(formatErrorMessage(detail, filename, tgError({ errorType: "ambiguous_period" })))
          .catch((e) => console.warn(`│        ⚠️  Telegram notify failed: ${e.message}`));
        await notifyFailure("ambiguous_period", { detail });
        return "rejected";
      }
      console.log(`│        📅  Multi-month mail (${named}) — this file names ${ownPeriods[0].beYear}_${String(ownPeriods[0].month).padStart(2, "0")}`);
      routingMonth = ownPeriods[0].month;
      routingYear = ownPeriods[0].beYear;
    } else {
      routingMonth = periods[0].month;
      routingYear = periods[0].beYear;
    }
  }

  // Sheet selection still needs a month number even when routing does not:
  // a physician who accumulates every month in one workbook uploads the same
  // file each time, and the right sheet is the one for the month they chose.
  const targetMonth = monthKey
    ? parseInt(String(monthKey).slice(5), 10)
    : routingMonth;
  const targetYear = monthKey
    ? parseInt(String(monthKey).slice(0, 4), 10)
    : routingYear
      ?? resolveBeYearByPriority(filename ?? "", subject, body)
      ?? resolveBeYear("", "", "", emailDate);

  // Parse workbook
  let rows, allSheets, chosenSheet, matchedSheet;
  try {
    ({ rows, allSheets, chosenSheet, matched: matchedSheet } = await firstSheetToRows(buffer, { targetMonth, targetYear }));
  } catch (err) {
    console.error(`│        ❌  Failed to parse workbook: ${err.message}`);
    await sendTelegram(formatErrorMessage(`Workbook parse failed: ${err.message}`, filename, tgError({ errorType: "other" }))).catch((e) => console.warn(`│        ⚠️  Telegram notify failed: ${e.message}`));
    await otherReply(`ไม่สามารถอ่านไฟล์ได้: ${err.message}`);
    return "replied";
  }

  console.log(`│        All sheets : ${allSheets.join(", ")}`);
  console.log(`│        Using sheet: "${chosenSheet}"`);
  console.log(`│        Rows       : ${rows.length}`);

  // ── Corruption checks ────────────────────────────────────────────────
  if (rows.length === 0) {
    const msg = "Workbook parsed but contains no data rows — file may be empty or corrupt.";
    console.error(`│        ❌  ${msg}`);
    await sendTelegram(formatErrorMessage(msg, filename, tgError({ errorType: "other" }))).catch((e) => console.warn(`│        ⚠️  Telegram notify failed: ${e.message}`));
    await otherReply("ไฟล์ไม่มีข้อมูล (0 แถว)");
    return "replied";
  }

  const nonNullCount = rows.reduce(
    (n, r) => n + Object.values(r).filter((v) => v !== null).length, 0
  );
  if (nonNullCount < 3) {
    const msg = `Workbook has only ${nonNullCount} non-null cell(s) — likely corrupt or blank.`;
    console.error(`│        ❌  ${msg}`);
    await sendTelegram(formatErrorMessage(msg, filename, tgError({ errorType: "other" }))).catch((e) => console.warn(`│        ⚠️  Telegram notify failed: ${e.message}`));
    await otherReply(`ไฟล์มีข้อมูลไม่ครบ (${nonNullCount} ช่อง)`);
    return "replied";
  }

  console.log(`│        Non-null cells: ${nonNullCount} ✅`);

  // ── Month cross-check (upload path only) ─────────────────────────────────
  // A file whose contents say July, uploaded under June, is the one mistake
  // this path can still make — everything else about it came from a verified
  // session. Deliberately reads the FILENAME and the sheet only, never
  // `subject`: the caller puts the selected month there as context for
  // Claude, so including it here would compare the selection against itself.
  // Only a month or year that actually resolved counts; an unstated month is
  // not a disagreement. Runs before Claude so a mismatch costs no API call.
  if (monthKey) {
    const fileMonth = resolveBeMonth(filename ?? "", "", "") ?? resolveBeMonthFromRows(rows);
    const fileYear  = resolveBeYear(filename ?? "", "", "") ?? resolveBeYearFromRows(rows);
    const selMonth  = parseInt(String(monthKey).slice(5), 10);
    const selYear   = parseInt(String(monthKey).slice(0, 4), 10);
    if ((fileMonth && fileMonth !== selMonth) || (fileYear && fileYear !== selYear)) {
      const inferredKey = `${fileYear ?? selYear}_${String(fileMonth ?? selMonth).padStart(2, "0")}`;
      const detail = `ไฟล์ระบุเดือน ${inferredKey} แต่เลือกส่งเดือน ${monthKey}`;
      console.error(`│        ❌  month_mismatch: ${detail}`);
      if (uploadCtx) uploadCtx.monthInFile = inferredKey;
      await sendTelegram(formatErrorMessage(detail, filename, tgError({ errorType: "month_mismatch" })))
        .catch((e) => console.warn(`│        ⚠️  Telegram notify failed: ${e.message}`));
      await notifyFailure("month_mismatch", { detail });
      return "rejected";
    }
  }

  const intermediate = {
    _email_subject  : subject,
    _email_body     : body,
    _email_from     : "",
    _email_date     : emailDate,
    _source_file    : filename,
    _selected_sheet : chosenSheet,
    _all_sheets     : allSheets,
    rows,
  };

  // Claude analysis
  console.log(`│        🤖  Sending to Claude for analysis…`);
  let analysis;
  try {
    analysis = await analyseJson(intermediate, filename);
    console.log(`│        ✅  Physician : ${analysis.name}`);
    console.log(`│        ✅  Date      : ${analysis.date}`);
    console.log(`│        ✅  Score     : ${analysis.score.toFixed(2)}`);
    if (analysis.score <= 0) throw new Error("Score is 0 — cannot save a zero score.");
  } catch (err) {
    const isZero = /score is 0/i.test(err.message);
    console.error(`│        ❌  Claude analysis failed: ${err.message}`);
    await sendTelegram(formatErrorMessage(err.message, filename, tgError({ errorType: isZero ? "zero_score" : "other" }))).catch((e) => console.warn(`│        ⚠️  Telegram notify failed: ${e.message}`));
    if (isZero) {
      await notifyFailure("zero_score", { detail: "ไม่พบคะแนนรวมในไฟล์" });
    } else {
      await otherReply(err.message);
    }
    return "replied";
  }

  // What the sender said this file is for outranks what Claude read out of
  // the sheet — and where they disagree, neither is written. The sheet was
  // already selected to match the stated period, so a disagreement here means
  // no sheet in the workbook matched and the fallback holds some other month:
  // exactly the case that would otherwise file one month's work under
  // another. Only a component that actually resolved is compared; an unstated
  // month or year is not a disagreement, same rule as the upload path's check.
  if (!monthKey && analysis.date) {
    const [claudeYear, claudeMonth] = String(analysis.date).split("_").map((n) => parseInt(n, 10));
    if ((routingMonth && claudeMonth && routingMonth !== claudeMonth) ||
        (routingYear && claudeYear && routingYear !== claudeYear)) {
      const statedKey = `${routingYear ?? claudeYear}_${String(routingMonth ?? claudeMonth).padStart(2, "0")}`;
      const detail = `อีเมล/ชื่อไฟล์ระบุเดือน ${statedKey} แต่ไฟล์ที่อ่านได้เป็นเดือน ${analysis.date}`;
      console.error(`│        ❌  month_mismatch: ${detail}`);
      if (uploadCtx) uploadCtx.monthInFile = analysis.date;
      await sendTelegram(formatErrorMessage(detail, filename, tgError({ errorType: "month_mismatch" })))
        .catch((e) => console.warn(`│        ⚠️  Telegram notify failed: ${e.message}`));
      // Both months by name, not just "an error occurred": this is the one
      // rejection the physician can resolve unaided, but only if the reply
      // says which month they asked for and which one the file turned out
      // to hold.
      await notifyFailure("month_mismatch", {
        detail,
        statedDate  : displayMonthKey(statedKey),
        detectedDate: displayMonthKey(analysis.date),
      });
      return "rejected";
    }
  }

  // ── The workbook must identify itself as the month picked (upload only) ──
  // The chip says what the physician MEANT to send; a tab named for that
  // month, or a title row naming it, is the file saying what they actually
  // sent. Without one there is nothing to check the chip against. The email
  // path is deliberately exempt: there the sender's own words already carry
  // that statement, and its own rules cover the rest.
  if (monthKey && !matchedSheet) {
    const detail = `ไม่พบเดือน ${displayMonthKey(monthKey)} ในไฟล์นี้`;
    console.error(`│        ❌  month_not_found: no sheet identifies ${monthKey} (sheets: ${allSheets.join(", ")})`);
    await sendTelegram(formatErrorMessage(detail, filename, tgError({ errorType: "month_not_found" })))
      .catch((e) => console.warn(`│        ⚠️  Telegram notify failed: ${e.message}`));
    await notifyFailure("month_not_found", { detail });
    return "rejected";
  }

  // The month everything downstream writes to. On the upload path the
  // physician picked it; on the email path the sender's own statement wins,
  // and Claude's reading is the fallback for a mail that states no period at
  // all. Either way the two have been checked to agree by this point.
  const statedMonth = routingMonth && routingYear
    ? `${routingYear}_${String(routingMonth).padStart(2, "0")}`
    : null;
  const workMonth = monthKey ?? statedMonth ?? analysis.date;

  // ── Roster resolution ────────────────────────────────────────────────────
  // Upload path: identity is already verified, so there is nothing to fuzzy-
  // match. The row comes from the exact match enqueue_p4p_upload() already
  // made, or — when that deferred (a name spelled differently in `physicians`
  // than in the roster, or two physicians sharing a name) — from ONE
  // matchName() call against the authenticated name. Claude's name output is
  // compared and reported, never routed on: a physician can legitimately
  // submit a workbook whose header carries a colleague's name if they copied
  // a template, and the score still belongs to the account that uploaded it.
  // `physician_not_found` is therefore structurally impossible here (§8).
  let match = null;
  if (isUpload) {
    if (uploadCtx) uploadCtx.nameInFile = analysis.name ?? null;
    try {
      if (identity.rosterIndex !== null && identity.rosterIndex !== undefined) {
        match = await getRosterRowByIndex(workMonth, identity.rosterIndex);
        if (match) console.log(`│        ✅  Roster row #${match.index} — "${match.matchedName}" (exact, from enqueue)`);
      }
      if (!match) {
        match = await matchName(identity.fullName, workMonth);
        if (match) {
          if (uploadCtx) uploadCtx.rosterMatch = `fuzzy ${(match.similarity * 100).toFixed(0)}%`;
          console.log(`│        ✅  Roster row #${match.index} — "${match.matchedName}" (fuzzy ${(match.similarity * 100).toFixed(0)}%)`);
        } else {
          if (uploadCtx) uploadCtx.rosterMatch = "none";
          console.warn(`│        ⚠️  "${identity.fullName}" is not in roster table "${workMonth}" — score cannot be written`);
        }
      }
      if (match && analysis.name && match.matchedName && analysis.name.trim() !== match.matchedName.trim()) {
        console.warn(`│        ⚠️  Name in file "${analysis.name}" ≠ account "${match.matchedName}" — writing to the authenticated account (cross-check only)`);
      }
    } catch (dbErr) {
      console.error(`│        ❌  Supabase match error: ${dbErr.message}`);
      await sendTelegram(formatErrorMessage(`Supabase match error: ${dbErr.message}`, filename, tgError({ errorType: "other" })))
        .catch((e) => console.warn(`│        ⚠️  Telegram notify failed: ${e.message}`));
      await otherReply(dbErr.message);
      return "replied";
    }
  } else {
  // ── Fuzzy name match (lookup only — score saved after Drive succeeds) ──
  console.log(`│        🔍  Fuzzy-matching name in Supabase table "${analysis.date}"…`);
  try {
    match = await matchName(analysis.name, analysis.date);
    if (match) {
      console.log(`│        ✅  Best match : "${match.matchedName}" (${(match.similarity * 100).toFixed(0)}% similar)`);
    } else {
      console.log(`│        ⚠️  No sufficiently similar name found.`);
    }
  } catch (dbErr) {
    console.error(`│        ❌  Supabase match error: ${dbErr.message}`);
    const isTableMissing = /does not exist|undefined_table|42P01|schema cache/i.test(dbErr.message);
    if (isTableMissing) {
      console.log(`│        📅  Table "${analysis.date}" not found — sending wrong_date reply`);
    }
    await sendAlertReply({
      errorType   : isTableMissing ? "wrong_date" : "other",
      safeFilename: filename ?? "",
      detectedDate: isTableMissing ? analysis.date : "",
      replyTo, messageId, gmail,
    });
    await sendTelegram(
      formatErrorMessage(
        isTableMissing
          ? `Table "${analysis.date}" not found — wrong date extracted from ${filename}`
          : `Supabase match error: ${dbErr.message}`,
        filename
      )
    ).catch((e) => console.warn(`│        ⚠️  Telegram notify failed: ${e.message}`));
    return "replied";
  }

  // ── Fallback: the winning name missed — try every other source ───────────
  // The pre-scan returns the filename's name whenever it finds one, but the
  // filename is the source senders most often get wrong (a comma for the
  // title's dot, a department word or month abbrev where the surname belongs).
  // Before declaring a mismatch, retry against the names the losing sources
  // produced — the subject and body first (the sender spelled those out
  // deliberately), then the workbook itself (a ชื่อแพทย์ header cell or the
  // sheet tab, which usually carry the correct name even when the file does not).
  if (!match) {
    const fallbackNames = [...new Set([
      ...resolvePhysicianNameCandidates(filename ?? "", subject, body),
      ...resolvePhysicianNameFromSheet(rows, chosenSheet),
    ])];
    for (const candidate of fallbackNames) {
      if (candidate === analysis.name) continue;
      let alt;
      try {
        alt = await matchName(candidate, analysis.date);
      } catch { continue; } // table/DB errors already surfaced by the primary match
      if (alt) {
        console.log(`│        🔁  Name "${analysis.name}" missed — recovered "${candidate}" → matched "${alt.matchedName}" (${(alt.similarity * 100).toFixed(0)}%)`);
        analysis.name = candidate;
        match = alt;
        break;
      }
    }
  }
  } // end email-only identity resolution

  // ── Upload to Google Drive (must succeed before saving score / archiving) ─
  const drive = getDrive();
  if (drive) {
    if (!match) {
      // On the upload path this is `not_in_roster`, not a name mismatch:
      // the account is verified, it simply has no row in this month's roster
      // to hang a score on — an admin problem, not the physician's.
      const who = isUpload ? identity.fullName : analysis.name;
      console.warn(`│        ⚠️  No roster row — Drive upload skipped for "${who}".`);
      await sendTelegram(
        formatErrorMessage(
          isUpload
            ? `Not in roster: "${who}" has no row in table "${workMonth}" — Drive upload skipped.`
            : `Name mismatch: "${analysis.name}" not found in table "${analysis.date}" — Drive upload skipped.`,
          filename,
          tgError({ errorType: "not_in_roster" })
        )
      ).catch((e) => console.warn(`│        ⚠️  Telegram notify failed: ${e.message}`));
    } else {
      const uploadName = match.matchedName;
      console.log(`│        📤  Preparing first-sheet buffer for Drive upload…`);
      try {
        const uploadBuffer = await extractFirstSheetBuffer(buffer);

        if (!uploadBuffer) {
          const msg = "First sheet is blank — Drive upload aborted.";
          console.warn(`│        ⚠️  ${msg}`);
          await sendTelegram(formatErrorMessage(msg, filename, tgError({ errorType: "other" }))).catch((e) => console.warn(`│        ⚠️  Telegram notify failed: ${e.message}`));
          await otherReply(msg);
          return "replied";
        }

        console.log(`│        📤  Uploading as "${uploadName}"…`);
        const { fileName, replaced } = await drive.uploadFile(
          uploadBuffer,
          uploadName,
          workMonth
        );
        console.log(`│        ✅  Drive upload: "${fileName}" (${replaced ? "replaced existing" : "new file"})`);
      } catch (driveErr) {
        console.error(`│        ❌  Drive upload failed: ${driveErr.message}`);
        await sendTelegram(
          formatErrorMessage(`Drive upload failed: ${driveErr.message}`, filename)
        ).catch((e) => console.warn(`│        ⚠️  Telegram notify failed: ${e.message}`));
        await otherReply();
        return "replied";  // ← do not archive, do not save score
      }
    }
  }

  // ── Save score to Supabase (only after Drive upload confirmed) ────────
  let ts = emailDate ? new Date(emailDate) : new Date();
  if (isNaN(ts.getTime())) {
    console.warn(`│        ⚠️  Unparseable email date "${emailDate}" — falling back to now`);
    ts = new Date();
  }
  let scoreSaved = false;
  if (match) {
    try {
      await saveScore(workMonth, match.index, analysis.score, ts.toISOString())
      scoreSaved = true;
      console.log(`│        💾  Score ${analysis.score.toFixed(2)} saved → table "${workMonth}", row ${match.index}`);
    } catch (dbErr) {
      console.error(`│        ❌  Supabase save error: ${dbErr.message}`);
    }
  }

  // ── Log submission for punctuality tracking ───────────────────────────
  if (scoreSaved) {
    try {
      await logSubmission({
        physicianName: match.matchedName,
        department   : match.department ?? "",
        workMonth,
        submittedAt  : ts.toISOString(),
        threadId     : threadId ?? null,
        filename     : filename ?? null,
      });
      console.log(`│        📊  Submission logged (punctuality)`);
    } catch (logErr) {
      console.warn(`│        ⚠️  Submission log skipped (non-fatal): ${logErr.message}`);
    }

    // ── Record sender → physician match (feeds the Telegram approve message) ──
    // Email path only: this table exists to learn which sender address belongs
    // to which physician. On the upload path that mapping is already known and
    // verified (it is the session), and there is no sender address to learn
    // from — `replyTo` is empty.
    if (!isUpload) try {
      await bumpSenderMatch({
        senderEmail       : replyTo,
        senderDisplayName,
        extractedName     : analysis.name,
        matchedPhysician  : match.matchedName,
        department        : match.department,
        similarity        : match.similarity,
      });
      console.log(`│        🗂️   sender_physician_match updated`);
    } catch (matchLogErr) {
      console.warn(`│        ⚠️  sender_physician_match update skipped (non-fatal): ${matchLogErr.message}`);
    }
  }

  // ── Telegram success notification ─────────────────────────────────────
  console.log(`│        📨  Sending to Telegram…`);
  try {
    await sendTelegram(formatResultMessage({
      name       : analysis.name,
      matchedName: match?.matchedName ?? null,
      similarity : match?.similarity  ?? null,
      date       : workMonth,
      score      : analysis.score.toFixed(2),
      saved      : scoreSaved,
    }, filename, uploadCtx));
    console.log(`│        ✅  Telegram message sent.`);
  } catch (tgErr) {
    console.error(`│        ❌  Telegram error: ${tgErr.message}`);
  }

  // ── Tell the physician ────────────────────────────────────────────────
  // Upload path: the caller's notify hooks own delivery (a LINE bubble, or
  // nothing at all when the physician is expected to pull the result from
  // the chat button they already have — §7.5). The pipeline stops knowing
  // which channel it is talking to here.
  if (isUpload) {
    if (!match) {
      await notifyFailure("not_in_roster", {
        detail: `ไม่พบรายชื่อของท่านในทะเบียนแพทย์เดือน ${workMonth}`,
      });
      return "replied";
    }
    if (notify?.ok) {
      await notify.ok({
        matchedName: match.matchedName,
        prefix     : match.prefix ?? "",
        department : match.department ?? "",
        monthKey   : workMonth,
        score      : analysis.score,
        scoreSaved,
        receivedAt : ts.toISOString(),
      });
    }
    return true;
  }

  // ── Auto-reply to sender (email path) ─────────────────────────────────
  if (replyTo && messageId) {
    if (!match) {
      await sendAlertReply({
        errorType   : "physician_not_found",
        safeFilename: filename ?? "",
        detectedName: analysis.name ?? "",
        replyTo, messageId, gmail,
      });
    } else {
      const [beYear, monthNum] = analysis.date.split("_");
      const thaiMonth  = THAI_MONTHS[parseInt(monthNum, 10)] || monthNum;
      const displayDate = `${thaiMonth} ${beYear}`;

      // Build display name: "prefix firstname  lastname" (1 space after prefix, 2 between names)
      const prefix = match.prefix ? `${match.prefix.trim()} ` : "";
      const nameParts = match.matchedName.trim().split(/\s+/);
      const spacedName = nameParts.length >= 2
        ? `${nameParts[0]}  ${nameParts.slice(1).join("  ")}`
        : match.matchedName;
      const displayName    = `${prefix}${spacedName}`;
      const department     = match.department ?? "";
      // buildHtmlReply escapes every value itself before interpolating into
      // HTML (defense-in-depth against XSS) — pass raw values here, not
      // pre-escaped ones, or they'd be double-escaped ("&" -> "&amp;amp;").
      const htmlReply = buildHtmlReply({
        displayName,
        safeDepartment : department,
        safeDisplayDate: displayDate,
        safeScore      : analysis.score.toFixed(2),
      });

      console.log(`│        📧  Sending auto-reply to ${replyTo}…`);
      try {
        await gmail.sendMessage({
          to              : replyTo,
          subject         : `องค์กรแพทย์ รพ. สค.`,
          html            : htmlReply,
          body            : `เรียน ${displayName}\n\nองค์กรแพทย์ โรงพยาบาลสมุทรสาคร ได้จัดเก็บไฟล์ P4P ของท่านแล้ว\n\nชื่อแพทย์: ${displayName}\nเดือน/ปี: ${displayDate}\nคะแนนรวม: ${analysis.score.toFixed(2)}\n\nขอบคุณที่ให้ความร่วมมือเป็นอย่างดี`,  // plain text — no escaping needed
          replyToMessageId: messageId,
        });
        console.log(`│        ✅  Auto-reply sent to ${replyTo}`);
      } catch (replyErr) {
        console.error(`│        ❌  Auto-reply failed: ${replyErr.message}`);
      }
    }
  }

  return true;
}

// ── Main ──────────────────────────────────────────────────────────────────

/**
 * Download and process a single Excel attachment through the full pipeline.
 * Extracted so multiple attachments can be processed in parallel via Promise.allSettled.
 */
async function processAttachment(att, messageId, context, gmail, workbookCount = 1) {
  const excel = isExcelFile(att.mimeType, att.filename);

  console.log(`│`);
  console.log(`│      • ${att.filename}`);
  console.log(`│        MIME type : ${att.mimeType}`);
  console.log(`│        Size      : ${formatSize(att.size)}`);
  console.log(`│        Excel?    : ${excel ? "✅  Yes" : "❌  No — skipping"}`);

  if (!excel) return false;

  if (isOfficeLockFile(att.filename)) {
    console.warn(`│        ⏭️   Excel lock/temp file — the real workbook was likely still open when this was sent. Skipping.`);
    await sendAlertReply({
      errorType   : "temp_file",
      safeFilename: att.filename ?? "",
      replyTo     : context.replyTo,
      messageId,
      gmail,
    });
    return "replied";
  }

  if (att.size > MAX_ATTACHMENT_SIZE_BYTES) {
    console.warn(`│        ⚠️  Attachment exceeds ${formatSize(MAX_ATTACHMENT_SIZE_BYTES)} limit — skipping download.`);
    await sendAlertReply({
      errorType   : "other",
      safeFilename: att.filename ?? "",
      replyTo     : context.replyTo,
      messageId,
      gmail,
    });
    return "replied";
  }

  let buffer;
  try {
    buffer = await gmail.downloadAttachment(messageId, att.attachmentId);
  } catch (err) {
    console.error(`│        ❌  Download failed: ${err.message}`);
    await sendAlertReply({
      errorType   : "other",
      safeFilename: att.filename ?? "",
      replyTo     : context.replyTo,
      messageId,
      gmail,
    });
    return "replied";
  }

  return processBuffer(buffer, { ...context, filename: att.filename, gmail, workbookCount });
}

async function main() {
  // Fail fast if any required env var is missing
  const { absentOptional } = checkEnv();
  if (absentOptional.length > 0) {
    log.info(`Optional env vars not set: ${absentOptional.join(", ")}`);
  }

  const gmail = createGmailClient();

  // ── Resolve "เอกสาร P4P" label ID once ───────────────────────────────
  // Used to tag processed messages. If the label doesn't exist yet,
  // create it in Gmail first (Settings → Labels → Create new label).
  const P4P_LABEL_NAME = "เอกสาร P4P";
  let p4pLabelId = null;
  try {
    const matched = await gmail.listLabels(P4P_LABEL_NAME);
    const label   = matched.find((l) => l.name === P4P_LABEL_NAME) ?? matched[0];
    if (label) {
      p4pLabelId = label.id;
      console.log(`🏷️   Label "${P4P_LABEL_NAME}" resolved (${p4pLabelId})`);
    } else {
      console.warn(`⚠️   Label "${P4P_LABEL_NAME}" not found — messages will not be labelled.`);
    }
  } catch (err) {
    console.warn(`⚠️   Could not resolve label: ${err.message}`);
  }

  // ── Fetch messages from INBOX, SPAM, and JUNK ────────────────────────
  // in:inbox / in:spam  → scope to folder
  // -is:starred         → not already processed
  // -has:userlabels     → not tagged with any user-created label
  // is:unread           → only new, unread messages
  const INBOX_QUERY = "in:inbox -is:starred -has:userlabels is:unread";
  const SPAM_QUERY  = "-is:starred -has:userlabels is:unread";

  console.log(`\n🔍  Fetching messages — INBOX …`);
  const inboxMessages = await gmail.listMessages({
    labelIds  : "INBOX",
    query     : INBOX_QUERY,
    maxResults: MAX_MESSAGES,
  });

  console.log(`🔍  Fetching messages — SPAM / Junk …`);
  const spamMessages = await gmail.listMessages({
    labelIds  : "SPAM",
    query     : SPAM_QUERY,
    maxResults: MAX_MESSAGES,
  });

  // Tag each message with its source folder so we can remove the right label later
  const messages = [
    ...inboxMessages.map((m) => ({ ...m, _sourceLabel: "INBOX" })),
    ...spamMessages.map((m) => ({ ...m, _sourceLabel: "SPAM" })),
  ];

  if (messages.length === 0) {
    console.log(`\n📭  No new unread unlabeled messages found (inbox + spam).`);
    console.log(`\n✅  Done.`);
    return;
  }

  console.log(`\n📬  ${messages.length} message(s) found (${inboxMessages.length} inbox, ${spamMessages.length} spam/junk):\n`);

  // Fetch full message data up front so we can process chronologically.
  // Gmail's messages.list has no orderBy and returns newest-first; without
  // resorting, a same-run correction (processed first) would get silently
  // overwritten by the older original (processed later) since saveScore/
  // uploadFile always overwrite unconditionally. Sorting oldest-first here
  // ensures the last write for a given physician+month is the most recent
  // email, not an arbitrary one.
  //
  // Promise.allSettled (not Promise.all) — a single message failing to fetch
  // (deleted mid-run, transient network error) must not abort the whole batch.
  // With Promise.all, one rejection discards every already-fulfilled fetch and
  // no message gets processed at all; allSettled keeps the rest going.
  const fetchResults = await Promise.allSettled(
    messages.map(async (m) => ({ ...m, ...(await gmail.getMessageWithAttachments(m.id)) }))
  );
  const fetchedMessages = [];
  fetchResults.forEach((r, idx) => {
    if (r.status === "fulfilled") {
      fetchedMessages.push(r.value);
    } else {
      console.error(`⚠️  Failed to fetch message ${messages[idx].id}: ${r.reason?.message ?? r.reason}`);
    }
  });
  fetchedMessages.sort((a, b) => {
    const da = new Date(a.msg.date).getTime();
    const db = new Date(b.msg.date).getTime();
    if (isNaN(da) || isNaN(db)) return 0; // unparseable date — keep original relative order
    return da - db;
  });

  for (let i = 0; i < fetchedMessages.length; i++) {
    const { id, _sourceLabel, msg, attachments } = fetchedMessages[i];

    const msgBody   = msg.body?.trim() ?? "";
    const fromRaw   = msg.from ?? "";
    const fromEmail = (fromRaw.match(/<(.+?)>/) ?? [, fromRaw])[1].trim().toLowerCase();
    const fromNameMatch    = fromRaw.match(/^(.*?)\s*<([^>]+)>\s*$/);
    const fromDisplayName  = fromNameMatch ? fromNameMatch[1].trim().replace(/^"(.*)"$/, "$1") : "";

    console.log(`┌─ [${i + 1}/${messages.length}] [${_sourceLabel}] ──────────────────────────────────────────`);
    console.log(`│  Date:     ${msg.date}`);
    console.log(`│  From:     ${msg.from}`);
    console.log(`│  Subject:  ${msg.subject}`);
    console.log(`│  Body:     ${msgBody.slice(0, 120).replace(/\n/g, " ")}${msgBody.length > 120 ? "…" : ""}`);

    if (SKIP_SENDERS.has(fromEmail)) {
      // Relay senders (see THREAD_RELAY_SENDERS) forward/reply to physician emails.
      // Instead of skipping, search the thread for an xlsx from the original sender.
      if (THREAD_RELAY_SENDERS.has(fromEmail) && msg.threadId) {
        console.log(`│  🔄  Relay sender — searching thread for xlsx from original messages…`);
        let relayProcessed = false;
        try {
          const threadMsgs = await gmail.getThreadMessages(msg.threadId);
          for (const tm of [...threadMsgs].reverse()) {
            if (tm.msg.id === id) continue;
            const tmEmail = (tm.msg.from.match(/<(.+?)>/) ?? [, tm.msg.from])[1].trim().toLowerCase();
            if (THREAD_RELAY_SENDERS.has(tmEmail)) continue; // skip other relay messages
            const xlsxInMsg = tm.attachments.filter((a) => isExcelFile(a.mimeType, a.filename));
            if (xlsxInMsg.length > 0) {
              console.log(`│  📎  Found xlsx in thread — original sender: ${tm.msg.from}`);
              const relayContext = {
                subject  : tm.msg.subject || msg.subject,
                body     : tm.msg.body    || msgBody,
                replyTo  : tmEmail,   // reply to the original physician, not the relay
                messageId: id,        // thread-link to the current (relay) message
                emailDate: msg.date,
                threadId : msg.threadId,
              };
              const results = await Promise.allSettled(
                xlsxInMsg.map((att) => processAttachment(att, tm.msg.id, relayContext, gmail, xlsxInMsg.length))
              );
              relayProcessed = results.some((r) => r.status === "fulfilled" && r.value === true);
              results.forEach((r, idx) => {
                if (r.status === "rejected") {
                  console.error(`│      ❌  Relay attachment[${idx}] threw: ${r.reason?.message ?? r.reason}`);
                }
              });
              if (relayProcessed) {
                const addLabels    = ["STARRED", ...(p4pLabelId ? [p4pLabelId] : [])];
                const removeLabels = ["UNREAD", _sourceLabel];
                try {
                  await gmail.modifyMessage(id, addLabels, removeLabels);
                  console.log(`│  🏷️   Marked: read · starred · archived · "${P4P_LABEL_NAME}"`);
                } catch (err) {
                  console.error(`│  ❌  Failed to update message labels: ${err.message}`);
                }
              }
              break;
            }
          }
        } catch (err) {
          console.warn(`│  ⚠️   Relay thread search failed: ${err.message}`);
        }
        if (!relayProcessed) {
          console.log(`│  📭  No xlsx found in thread from original sender — skipping`);
        }
      } else {
        console.log(`│  ⏭️   Sender is on the skip list — skipping.`);
      }
      console.log(`└────────────────────────────────────────────────────────────\n`);
      continue;
    }

    let processedAnyAttachment = false;

    // ── Pre-flight error checks ───────────────────────────────────────────
    // Classify message-level issues before touching attachments.
    // Only send an alert reply when no xlsx file is present — if xlsx
    // files exist alongside other attachments, process normally.
    const xlsxAtts  = attachments.filter((a) => isExcelFile(a.mimeType, a.filename));
    const otherAtts = attachments.filter((a) => !isExcelFile(a.mimeType, a.filename));

    if (xlsxAtts.length === 0) {
      // ── Thread search: look for xlsx in earlier messages of this thread ──
      let threadXlsx = null; // { messageId, att }
      if (msg.threadId) {
        try {
          const threadMsgs = await gmail.getThreadMessages(msg.threadId);
          // Iterate newest-first so we pick the most recent xlsx in the thread
          for (const tm of [...threadMsgs].reverse()) {
            if (tm.msg.id === id) continue; // already checked current message
            const found = tm.attachments.filter((a) => isExcelFile(a.mimeType, a.filename));
            if (found.length > 0) {
              threadXlsx = { messageId: tm.msg.id, atts: found };
              break;
            }
          }
        } catch (err) {
          console.warn(`│  ⚠️   Thread search failed: ${err.message}`);
        }
      }

      if (threadXlsx) {
        console.log(`│  🔍  No xlsx in this message — found xlsx in thread (message ${threadXlsx.messageId})`);
        console.log(`│  📎  ${threadXlsx.atts.length} xlsx attachment(s) from thread:`);
        const context = {
          subject  : msg.subject,
          body     : msgBody,
          replyTo  : fromEmail,
          senderDisplayName: fromDisplayName,
          messageId: id,
          emailDate: msg.date,
          threadId : msg.threadId,
        };
        const results = await Promise.allSettled(
          threadXlsx.atts.map((att) => processAttachment(att, threadXlsx.messageId, context, gmail, threadXlsx.atts.length))
        );
        processedAnyAttachment = results.some(
          (r) => r.status === "fulfilled" && r.value === true
        );
        results.forEach((r, idx) => {
          if (r.status === "rejected") {
            console.error(`│      ❌  Thread attachment[${idx}] threw: ${r.reason?.message ?? r.reason}`);
          }
        });
        if (processedAnyAttachment) {
          const addLabels    = ["STARRED", ...(p4pLabelId ? [p4pLabelId] : [])];
          const removeLabels = ["UNREAD", _sourceLabel];
          try {
            await gmail.modifyMessage(id, addLabels, removeLabels);
            console.log(`│  🏷️   Marked: read · starred · archived · "${P4P_LABEL_NAME}"`);
          } catch (err) {
            console.error(`│  ❌  Failed to update message labels: ${err.message}`);
          }
        }
        console.log(`└────────────────────────────────────────────────────────────\n`);
        continue;
      }

      let alertSent = false;
      if (CLOUD_LINK_RE.test(msgBody)) {
        // Sender pasted a cloud-storage link instead of attaching the file
        console.log(`│  ⚠️   No xlsx found — cloud link detected in body → sending file_link alert`);
        await sendAlertReply({ errorType: "file_link", safeFilename: "", replyTo: fromEmail, messageId: id, gmail });
        alertSent = true;
      } else if (otherAtts.length > 0) {
        // Sender attached a file but in the wrong format (.xls, .ods, …)
        const names = otherAtts.map((a) => a.filename).join(", ");
        console.log(`│  ⚠️   No xlsx found — wrong extension(s): ${names} → sending wrong_extension alert`);
        await sendAlertReply({ errorType: "wrong_extension", safeFilename: names, replyTo: fromEmail, messageId: id, gmail });
        alertSent = true;
      } else {
        console.log(`│  📎  No attachments and no cloud link — skipping`);
      }
      if (alertSent) {
        const addLabels    = ["STARRED", ...(p4pLabelId ? [p4pLabelId] : [])];
        const removeLabels = ["UNREAD", _sourceLabel];
        try {
          await gmail.modifyMessage(id, addLabels, removeLabels);
          console.log(`│  🏷️   Marked: read · starred · archived · "${P4P_LABEL_NAME}"`);
        } catch (err) {
          console.error(`│  ❌  Failed to update message labels: ${err.message}`);
        }
      }
      console.log(`└────────────────────────────────────────────────────────────\n`);
      continue;
    }

    console.log(`│  📎  ${attachments.length} attachment(s):`);

    // Process all Excel attachments in parallel — faster for messages with multiple files
    // Use fromEmail (plain addr) not msg.from (full header) for replyTo —
    // the full From: header can contain RFC 2047-encoded display names in many
    // formats; using just the address avoids any encoding issue in To: header.
    const context = {
      subject  : msg.subject,
      body     : msgBody,
      replyTo  : fromEmail,
      senderDisplayName: fromDisplayName,
      messageId: id,
      emailDate: msg.date,
      threadId : msg.threadId,
    };
    const workbookCount = attachments.filter((a) => isExcelFile(a.mimeType, a.filename)).length;
    const results = await Promise.allSettled(
      attachments.map((att) => processAttachment(att, id, context, gmail, workbookCount))
    );
    processedAnyAttachment = results.some(
      (r) => r.status === "fulfilled" && r.value === true
    );
    const repliedToAny = results.some(
      (r) => r.status === "fulfilled" && r.value === "replied"
    );
    results.forEach((r, idx) => {
      if (r.status === "rejected") {
        console.error(`│      ❌  Attachment[${idx}] threw: ${r.reason?.message ?? r.reason}`);
      }
    });

    // ── Mark message: read + starred + labeled ────────────────────────
    // Applied after a successful processing OR after an alert reply was sent.
    if (processedAnyAttachment || repliedToAny) {
      const addLabels    = ["STARRED", ...(p4pLabelId ? [p4pLabelId] : [])];
      const removeLabels = ["UNREAD", _sourceLabel];
      try {
        await gmail.modifyMessage(id, addLabels, removeLabels);
        console.log(`│  🏷️   Marked: read · starred · archived · "${P4P_LABEL_NAME}"`);
      } catch (err) {
        console.error(`│  ❌  Failed to update message labels: ${err.message}`);
      }
    }

    console.log(`└────────────────────────────────────────────────────────────\n`);
  }

  console.log(`\n✅  Done.`);
}

// Run the Gmail poller only when this file IS the program being run. It also
// exports processBuffer()/extractFirstSheetBuffer() for the LINE-upload drain
// (scripts/drain-uploads.mjs), and importing those must not start polling
// Gmail — the ESM equivalent of `require.main === module`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("\n❌  Fatal error:", err.message);
    process.exit(1);
  });
}