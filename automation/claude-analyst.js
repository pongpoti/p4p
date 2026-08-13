/**
 * claude-analyst.js
 *
 * Uses Anthropic Claude Messages API.
 * Set ANTHROPIC_API_KEY in .env
 *
 * Export: analyseJson
 *   Returns { name, date, score } from a physician workload Excel sheet.
 */

import Anthropic from "@anthropic-ai/sdk";
import { MAX_ROW_JSON_CHARS, CLAUDE_MAX_TOKENS } from "./config.js";

// ── Singleton client ───────────────────────────────────────────────────────
let _client = null;
function getClient() {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY in .env");
  const baseURL = process.env.ANTHROPIC_BASE_URL;
  _client = new Anthropic({ apiKey, ...(baseURL && { baseURL }) });
  return _client;
}

/** Strip markdown code fences Claude occasionally wraps around JSON */
function stripFences(str) {
  return str
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

// ── JS-side BE year resolver ───────────────────────────────────────────────
// Resolves the BE year from text before sending to Claude — removes all
// arithmetic from Claude's responsibility entirely.

/**
 * Extract and convert any year expression to a 4-digit BE year.
 * Searches in priority order: subject → body → filename (most → least reliable).
 * Falls back to the email's received date (if provided) when no year
 * appears in any text source — e.g. a sender who writes "เดือน มิถุนายน"
 * but never mentions the year anywhere (subject, body, filename, or sheet).
 * Returns null if no year found.
 */
export function resolveBeYear(filename, subject, body, emailDate = null) {
  // Use (?<!\d) / (?!\d) instead of \b so that underscore-delimited numbers
  // in filenames like "P4P_2569_02.xlsx" are matched correctly.
  // (\b does NOT fire between _ and a digit because _ is a \w character.)
  //
  // Scan by CONFIDENCE TIER across all sources rather than all tiers within one source.
  // This prevents a weak match (e.g. "15" → short CE 2558) in the subject from winning
  // over a strong match ("2569" → full BE) in the filename.
  // Within each tier, all sources are collected and the NEWEST (largest) year wins,
  // rather than the first source found — e.g. a stale year left in an email subject
  // (from a copy-pasted previous month's email) must not shadow a newer, more
  // reliable year in the filename or attachment.
  const all    = [subject ?? "", body ?? "", filename ?? ""];
  const noBody = [subject ?? "", filename ?? ""];   // body excluded from short-CE scan (day numbers)

  // Tier 1 — full BE year 25xx (unambiguous — always wins)
  const tier1 = all
    .map(t => t.match(/(?<!\d)(25\d{2})(?!\d)/))
    .filter(Boolean)
    .map(m => parseInt(m[1], 10));
  if (tier1.length) return Math.max(...tier1);

  // Tier 2 — full CE year 20xx
  const tier2 = all
    .map(t => t.match(/(?<!\d)(20\d{2})(?!\d)/))
    .filter(Boolean)
    .map(m => parseInt(m[1], 10) + 543);
  if (tier2.length) return Math.max(...tier2);

  // Tier 3 — 2-digit short BE 43–99 (e.g. 69 → 2569)
  const tier3 = all
    .map(t => t.match(/(?<!\d)(4[3-9]|[5-9]\d)(?!\d)/))
    .filter(Boolean)
    .map(m => 2500 + parseInt(m[1], 10));
  if (tier3.length) return Math.max(...tier3);

  // Tier 4 — 2-digit short CE 00–42 (e.g. 26 → 2026 → 2569)
  // Body excluded: day numbers like "วันที่ 15" are too noisy.
  const tier4 = noBody
    .map(t => t.match(/(?<!\d)([0-3]\d|4[0-2])(?!\d)/))
    .filter(Boolean)
    .map(m => 2000 + parseInt(m[1], 10) + 543);
  if (tier4.length) return Math.max(...tier4);

  // Tier 5 — no year mentioned anywhere: fall back to the email's received
  // date. Submissions are near-always for the current or previous month, so
  // the year the email arrived in is a safe last resort.
  if (emailDate) {
    const d = new Date(emailDate);
    if (!isNaN(d.getTime())) return d.getFullYear() + 543;
  }

  return null;
}

/**
 * Fallback: scan the first few data rows for a BE year embedded in cell text.
 * Handles files where the year appears only inside the sheet (e.g. "พ.ศ. ....2569....").
 * Applies the same tier logic as resolveBeYear: full BE 25xx first, then CE 20xx.
 */
export function resolveBeYearFromRows(rows) {
  const beYearRe = /(?<!\d)(25\d{2})(?!\d)/;
  const ceYearRe = /(?<!\d)(20\d{2})(?!\d)/;
  for (const row of rows.slice(0, 15)) {
    for (const val of Object.values(row)) {
      if (val === null || val === undefined) continue;
      const s = String(val);
      let m = s.match(beYearRe);
      if (m) return parseInt(m[1], 10);
      m = s.match(ceYearRe);
      if (m) return parseInt(m[1], 10) + 543;
    }
  }
  return null;
}

// ── JS-side month resolver ────────────────────────────────────────────────
// Returns 1–12 from any text source (filename / subject / body).
// Used to select the correct sheet in multi-sheet workbooks.

const MONTH_TOKEN_MAP = (() => {
  // Pairs of [token, monthNumber]. Longer tokens listed first so that
  // e.g. "มกราคม" is matched before the shorter "มกรา" / "มกร".
  const entries = [
    ["มกราคม",1],["January",1],["มกรา",1],["มกร",1],["มค",1],
    ["กุมภาพันธ์",2],["February",2],["กุมภา",2],["กุมภ",2],["กพ",2],
    ["มีนาคม",3],["March",3],["มีนา",3],["มีน",3],["มีค",3],
    ["เมษายน",4],["April",4],["เมษา",4],["เมษ",4],["เมย",4],
    ["เมศายน",4],["เมศา",4],["เมศ",4],                          // ษ→ศ typo variants
    ["พฤษภาคม",5],["May",5],["พฤษภ",5],["พฤษ",5],["พค",5],
    ["พฤศภาคม",5],["พฤศภ",5],                                    // ษ→ศ typo variants
    ["มิถุนายน",6],["June",6],["มิถุน",6],["มิถุ",6],["มิย",6],
    ["กรกฎาคม",7],["July",7],["กรกฎ",7],["กรก",7],["กค",7],
    ["สิงหาคม",8],["August",8],["สิงหา",8],["สิงห",8],["สค",8],
    ["กันยายน",9],["September",9],["กันยา",9],["กันย",9],["กย",9],
    ["ตุลาคม",10],["October",10],["ตุลา",10],["ตุล",10],["ตค",10],
    ["พฤศจิกายน",11],["November",11],["พฤศจิ",11],["พฤศ",11],["พย",11],
    ["พฤษจิกายน",11],["พฤษจิ",11],                               // ศ→ษ typo variants
    ["ธันวาคม",12],["December",12],["ธันวา",12],["ธันว",12],["ธค",12],
  ];
  return entries; // order matters — scan longest-first within each month
})();

/**
 * Extract the month number (1–12) from filename / subject / body.
 * Sources checked in order: subject → body → filename.
 * Returns null if not found.
 */
export function resolveBeMonth(filename, subject, body) {
  const sources = [subject ?? "", body ?? "", filename ?? ""];
  for (const t of sources) {
    for (const [token, mo] of MONTH_TOKEN_MAP) {
      // Latin tokens: require word boundary to avoid "May" inside "Maybe"
      if (/^[A-Za-z]+$/.test(token)) {
        if (new RegExp(`\\b${token}\\b`, "i").test(t)) return mo;
      } else if (t.includes(token)) {
        return mo;
      }
    }
  }
  return null;
}

// ── JS-side physician name resolver ───────────────────────────────────────
// (A TITLE_PREFIX_RE constant used to sit here. Nothing referenced it: title
// stripping is done by Pattern 1's `titleRe`, which captures the name AFTER the
// title rather than removing it, and by the `deTitled` replace ahead of
// Pattern 2. Both are in extractNameFromText below.)

// Thai words that are not physician names (common non-name tokens in filenames/subjects)
const NON_NAME_THAI = new Set([
  "P4P", "เดือน", "ปี", "แพทย์", "โรงพยาบาล", "รพ", "ผลงาน", "คะแนน",
  "แต้ม", "รวม", "ข้อมูล", "ส่ง", "ไฟล์", "สค", "สมุทรสาคร", "องค์กร",
  "ฝ่าย", "กลุ่ม", "งาน", "ประจำ", "ทำงาน",
  // Thai month names (full) — filenames like "ศาศวัต มีนาคม.xlsx" must not treat
  // the month word as a lastname
  "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
  // Thai month abbreviations (no dots — dots are stripped by the Thai-char regex)
  "มค", "กพ", "มีค", "เมย", "พค", "มิย", "กค", "กย", "ตค", "พย", "ธค",
  // Extended month truncations that appear in filenames (e.g. "เมษ 69", "เมษา 69")
  // Without these, e.g. "เมษ" would be mistaken for a lastname.
  "เมษ", "เมษา",   // เมษายน  (April)
  "มกรา", "มกร",   // มกราคม  (January)
  "กุมภา", "กุมภ", // กุมภาพันธ์ (February)
  "มีนา", "มีน",   // มีนาคม  (March)
  "พฤษภ", "พฤษ",   // พฤษภาคม (May)
  "มิถุน", "มิถุ", // มิถุนายน (June)
  "กรกฎ", "กรก",   // กรกฎาคม (July)
  "สิงหา", "สิงห", // สิงหาคม (August)
  "กันยา", "กันย", // กันยายน (September)
  "ตุลา", "ตุล",   // ตุลาคม  (October)
  "พฤศจิ", "พฤศ",  // พฤศจิกายน (November)
  "ธันวา", "ธันว", // ธันวาคม (December)
  // ── ษ ↔ ศ misspellings ──────────────────────────────────────────────────
  // Thai writers frequently swap ษ (tho phuthao) and ศ (so sala) — they are
  // visually similar and share the same romanisation.  The misspelled forms
  // are NOT real lastnames, so they must be excluded just like the correct ones.
  "พฤศภาคม", "พฤศภ",         // misspelling of พฤษภาคม / พฤษภ (May)
  "เมศายน", "เมศา", "เมศ",   // misspelling of เมษายน / เมษา / เมษ (April)
  "พฤษจิกายน", "พฤษจิ",      // misspelling of พฤศจิกายน / พฤศจิ (November)
  // ── Name-label words ─────────────────────────────────────────────────────
  // Header labels that sit next to the real name in a "ชื่อแพทย์" cell — they
  // are never name components and must not be picked up as a first/last name.
  "ชื่อแพทย์", "ชื่อ", "นามสกุล", "สกุล", "ชื่อสกุล", "กลุ่มงาน",
  // ── Department names (single-token) ──────────────────────────────────────
  // Senders sometimes put the department where the surname should go in the
  // filename (e.g. "P4P วราวุธ อายุรกรรม เม.ย.69.xlsx").  These are department
  // names, never lastnames — exclude so the firstname-only fallback fires.
  "อายุรกรรม", "ศัลยกรรม", "กุมารเวชกรรม", "จักษุวิทยา", "นิติเวช",
  "รังสีวิทยา", "วิสัญญีวิทยา", "เวชกรรมฟื้นฟู", "เวชกรรมสังคม",
  "อาชีวเวชกรรม", "ศัลยกรรมออร์โธปิดิกส์", "ออร์โธปิดิกส์",
  "เวชศาสตร์ฉุกเฉิน", "ผู้ป่วยนอก", "จิตเวช",
]);

// Canonical month strings (≥ 4 chars) used as fuzzy-match targets.
// Short abbreviations (≤ 3 chars) are covered by exact NON_NAME_THAI.has() and
// their floor(len/4) threshold would be 0, so they give no fuzzy benefit.
const MONTH_FUZZY_TARGETS = [
  // Full names
  "มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน",
  "กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม",
  // Truncated forms (4–6 chars)
  "มกรา","กุมภา","กุมภ","มีนา","เมษา","พฤษภ","มิถุน","มิถุ",
  "กรกฎ","สิงหา","กันยา","กันย","ตุลา","พฤศจิ","พฤศ","ธันวา","ธันว",
  // ษ↔ศ variants
  "เมศายน","เมศา","พฤศภาคม","พฤศภ","พฤษจิกายน","พฤษจิ",
];

/** Levenshtein distance (character-level). */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const row = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      row[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, row[j], row[j - 1]);
      prev = tmp;
    }
  }
  return row[n];
}

/**
 * Returns true if token is a known non-name word (exact match in NON_NAME_THAI)
 * OR looks like a misspelled Thai month name (Levenshtein ≤ floor(canonical.length / 4)).
 * Tokens shorter than 3 chars skip the fuzzy path to avoid false positives.
 */
function isNonName(token) {
  if (NON_NAME_THAI.has(token)) return true;
  if (token.length < 3) return false;
  for (const canonical of MONTH_FUZZY_TARGETS) {
    const threshold = Math.floor(canonical.length / 4);
    if (threshold > 0 && levenshtein(token, canonical) <= threshold) return true;
  }
  return false;
}

/**
 * Try to extract "firstname lastname" from a single text string.
 * Strategy:
 *   1. Title prefix + two Thai words  (most reliable — "นพ.สมชาย ใจดี")
 *   2. Two consecutive Thai words separated by space/underscore/dash
 *      (filename pattern — "สมชาย_ใจดี.xlsx")
 * Returns "firstname lastname" with no title, or null.
 */
function extractNameFromText(text) {
  if (!text) return null;

  // Normalise dotted title abbreviations ONLY (before Pattern 1) so that both
  // "นพ." and "น.พ." / "พญ." and "พ.ญ." etc. are matched by the same regex.
  // Also collapse dotted Thai month abbreviations here so Pattern 1 sees "มีค"
  // (which is in NON_NAME_THAI) instead of the bare "มี" fragment before the dot.
  const titleNorm = text
    .replace(/น\.พ\./g,    "นพ.")
    .replace(/พ\.ญ\./g,    "พญ.")
    .replace(/ท\.พ\./g,    "ทพ.")
    .replace(/ท\.พ\.ญ\./g, "ทพญ.")
    .replace(/ด\.ร\./g,    "ดร.")
    .replace(/ม\.ค\.?/g,   "มค")
    .replace(/ก\.พ\.?/g,   "กพ")
    .replace(/มี\.ค\.?/g,  "มีค")
    .replace(/เม\.ย\.?/g,  "เมย")
    .replace(/พ\.ค\.?/g,   "พค")
    .replace(/มิ\.ย\.?/g,  "มิย")
    .replace(/ก\.ค\.?/g,   "กค")
    .replace(/ส\.ค\.?/g,   "สค")
    .replace(/ก\.ย\.?/g,   "กย")
    .replace(/ต\.ค\.?/g,   "ตค")
    .replace(/พ\.ย\.?/g,   "พย")
    .replace(/ธ\.ค\.?/g,   "ธค")
    // Comma typed where the title's dot belongs — "," and "." sit on adjacent
    // keys, so "นพ,สมชาย" / "พญ,แพร" are a frequent slip.  Runs after the month
    // rules so "ม.ค." is already "มค" and cannot be mangled here.
    .replace(/(นพ|พญ|ทพญ|ทพ|ดร)\s*,\s*/g, "$1.");

  // Pattern 1: run on titleNorm so title dots are intact but dotted variants
  // are already collapsed ("พ.ญ.ศาศวัต" → "พญ.ศาศวัต" → matched correctly).
  // "P4P นพ.ศาศวัต มีนาคม 2569"   → "ศาศวัต" (month discarded)
  // "P4P พ.ญ.ศาศวัต มีนาคม 2569"  → "ศาศวัต" (dotted title normalised first)
  const titleRe = /(?:นพ\.|พญ\.|นายแพทย์|แพทย์หญิง|ทพ\.|ทพญ\.|ดร\.)\s*([\u0E00-\u0E7F]{2,})(?:\s+([\u0E00-\u0E7F]{2,}))?/;
  const m1 = titleNorm.match(titleRe);
  if (m1) {
    const first = m1[1];
    const last  = m1[2];
    // If the word after the firstname is a month name, discard it — return firstname only
    if (last && !isNonName(last)) return `${first} ${last}`;
    return first; // single-token → will hit firstname-only Supabase lookup
  }

  // Drop title prefixes before Pattern 2 so the dot-collapse below cannot weld
  // one onto the firstname.  Two forms are stripped:
  //   • known multi-char titles  — "นพ.สมชาย"        → "สมชาย"
  //   • a bare one-letter prefix — "พ.แพร" / "พ,แพร" → "แพร"
  // Without this the collapse turned a "พ.แพร จันทรรังสรรค์" subject line into
  // "พแพร จันทรรังสรรค์", which matches no physician in the database.  Month
  // abbreviations were already collapsed in titleNorm ("พ.ค." → "พค"), so no
  // month token can be mistaken for a one-letter prefix here.
  const deTitled = titleNorm
    .replace(/(^|[\s(_\-–])(?:นพ|พญ|ทพญ|ทพ|ดร)\s*\.\s*/g, "$1")
    .replace(/(^|[\s(_\-–])[฀-๿]\s*[.,]\s*(?=[฀-๿]{2,})/g, "$1");

  // Collapse dots between Thai characters only for Pattern 2 (month abbreviations).
  // Done AFTER Pattern 1 so title dots ("นพ.") are never destroyed.
  //   "มี.ค."  →  "มีค."  →  twoWordRe captures "มีค" → blocked by NON_NAME_THAI
  //   "เม.ย."  →  "เมย."
  const text2 = deTitled.replace(/([\u0E00-\u0E7F]+)\.(?=[\u0E00-\u0E7F])/g, "$1");

  // Split compound เดือน<monthname> tokens so each part is checked individually.
  // เดือนมกราคม → เดือน มกราคม — both are in NON_NAME_THAI and get rejected below.
  const text3 = text2.replace(
    /เดือน(มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม)/g,
    "เดือน $1"
  );

  // Pattern 2: two consecutive Thai-character sequences (min 2 chars each),
  // separated by one of: space, underscore, dash, dot, comma — but NOT a digit
  // boundary.  Comma is included because senders type it where the dot or space
  // belongs ("แพร,จันทรรังสรรค์"); without it such a pair never matched at all.
  // Both words must not be in the NON_NAME_THAI exclusion set.
  const twoWordRe = /([\u0E00-\u0E7F]{2,})[\s_\-.,]+([\u0E00-\u0E7F]{2,})/g;
  let m2;
  let singleTokenFallback = null; // best firstname when no full pair is found
  while ((m2 = twoWordRe.exec(text3)) !== null) {
    const first = m2[1];
    const last  = m2[2];
    if (!isNonName(first) && !isNonName(last)) {
      return `${first} ${last}`;
    }
    // When first is valid but second is a non-name token (e.g. a month), record
    // it as a single-token candidate — mirrors Pattern 1's firstname-only return.
    if (!singleTokenFallback && !isNonName(first) && isNonName(last)) {
      singleTokenFallback = first;
    }
  }

  if (singleTokenFallback) return singleTokenFallback;

  // Pattern 3 (last resort): a single valid Thai token surrounded by non-Thai text.
  // Handles filenames like "P4P จิรภัทร May 69 (1) (4) (1)" where there is only
  // one Thai word and Pattern 2 never fires (it needs two Thai tokens to match).
  // Only returns if exactly one non-excluded Thai word exists — avoids false positives
  // when multiple Thai words are present but none formed a valid pair.
  const soloRe = /[฀-๿]{2,}/g;
  const soloHits = [...text3.matchAll(soloRe)].map((m) => m[0]).filter((t) => !isNonName(t));
  if (soloHits.length === 1) return soloHits[0];

  return null;
}

/**
 * Extract physician name (firstname + lastname, no title) in priority order:
 *   1. Excel attachment filename
 *   2. Email subject
 *   3. Email body
 * Returns the first plausible name found, or null (caller falls back to sheet/Claude).
 */
export function resolvePhysicianName(filename, subject, body) {
  return resolvePhysicianNameCandidates(filename, subject, body)[0] ?? null;
}

/**
 * Every distinct name the filename / subject / body yield, in that priority
 * order.  resolvePhysicianName() returns the first one; callers that can verify
 * a name against the database use the rest as fallbacks when the winner misses.
 *
 * The filename is scanned first because it is usually the cleanest source, but
 * it is not always right — senders mistype it (a comma for the title's dot, a
 * department word where the surname belongs) while the subject line spells the
 * name out correctly.  Keeping the losing sources means one bad filename no
 * longer costs the whole match.
 *
 * @returns {string[]} ordered, de-duplicated candidates (may be empty)
 */
export function resolvePhysicianNameCandidates(filename, subject, body) {
  // Strip file extension from filename before scanning
  const fileBase = (filename ?? "").replace(/\.[^.]+$/, "");

  const sources = [
    fileBase,
    subject ?? "",
    body    ?? "",
  ];

  const candidates = [];
  for (const src of sources) {
    const name = extractNameFromText(src);
    if (name && !candidates.includes(name)) candidates.push(name);
  }

  return candidates;
}

/**
 * Fallback name resolver — extract physician-name candidates from inside the
 * workbook itself (sheet content + tab name).
 *
 * Used only when the filename/subject/body pre-scan produced a name that did
 * NOT match any physician in the database.  In practice the real name is still
 * written correctly inside the file even when the sender mis-named it:
 *   • a "ชื่อแพทย์ นพ. วราวุธ เมธีศิริวัฒน์" header cell, or
 *   • the worksheet tab name ("ปัทมิกา เจียรวุฒิสาร เมย.69").
 *
 * Returns an ordered, de-duplicated list of "firstname lastname" candidates
 * (titles stripped), most-reliable first.  Caller tries matchName on each.
 *
 * @param {object[]} rows       Sheet rows ({ col_1, col_2, ... })
 * @param {string}   sheetName  The chosen worksheet's tab name
 * @returns {string[]}
 */
export function resolvePhysicianNameFromSheet(rows = [], sheetName = "") {
  const candidates = [];
  const add = (n) => { if (n && !candidates.includes(n)) candidates.push(n); };

  // Cells whose text identifies the physician-name row.
  const NAME_LABEL_RE = /ชื่อ\s*[-–]?\s*สกุล|ชื่อแพทย์|ชื่อ\s*นามสกุล|^\s*ชื่อ\b|นามสกุล/;

  // 1. Scan the first few rows for a "ชื่อแพทย์ …" header cell.
  const seen = new Set();
  for (const row of (rows ?? []).slice(0, 10)) {
    for (const val of Object.values(row ?? {})) {
      const s = String(val ?? "").trim();
      if (!s || seen.has(s)) continue;
      seen.add(s);
      if (!NAME_LABEL_RE.test(s)) continue;
      // Try the raw cell first (title-anchored Pattern 1 handles "นพ. X Y"),
      // then a label-stripped, dot-stripped variant for untitled names.
      add(extractNameFromText(s));
      const stripped = s
        .replace(/ชื่อแพทย์|ชื่อ\s*[-–]?\s*สกุล|ชื่อ\s*นามสกุล|นามสกุล|ชื่อ/g, " ")
        .replace(/[.…]+/g, " ");
      add(extractNameFromText(stripped));
    }
  }

  // 2. Worksheet tab name (e.g. "ปัทมิกา เจียรวุฒิสาร เมย.69").
  add(extractNameFromText(sheetName ?? ""));

  return candidates;
}

// Labels that only appear as grand-total row markers — safe to search ALL columns
const GRAND_TOTAL_LABELS = [
  "รวมแต้มทั้งหมด", "รวมคะแนนทั้งหมด", "รวมทั้งสิ้น", "ยอดรวมทั้งหมด",
  "รวมทั้งหมด", "คะแนนรวมทั้งหมด",
];

// Sub-total labels — only checked in first 3 columns to avoid false-matching
// column headers (some sheets have "รวมแต้ม" as a column header in col_5+)
const SUBTOTAL_LABELS = [
  "รวมคะแนน", "รวมแต้ม", "คะแนนรวม", "ผลรวม", "รวม",
];

// Combined for weight×day fallback (avoid importing twice)
const TOTAL_LABELS = [...GRAND_TOTAL_LABELS, ...SUBTOTAL_LABELS];

// Merged label cells sometimes carry internal whitespace (e.g. a cell that
// reads "รวมคะแนน ทั้งหมด" instead of "รวมคะแนนทั้งหมด"). Strip all whitespace
// before comparing so label matching isn't sensitive to that formatting.
const stripSpace = (s) => s.replace(/\s+/g, "");
const includesLabel = (text, label) => stripSpace(text).includes(stripSpace(label));

/** True if n looks like a calendar year and not a score. */
function isYearLike(n) {
  if (n >= 1900 && n <= 2099) return true;
  // BE year range (2400–2699): years are always whole numbers, so fractional
  // values like 2408.56 are scores, not years.
  if (n >= 2400 && n <= 2699 && Number.isInteger(n)) return true;
  return false;
}

/**
 * Extract all positive, non-year numbers embedded in a mixed text+number string.
 * Handles cells like "รวมทั้งหมด  = 11011.5" where label and score share one cell.
 * @param {*} val
 * @param {boolean} [skipYearFilter] - when true, accept year-like integers as scores
 */
function numsFromText(val, skipYearFilter = false) {
  const s = String(val ?? "").replace(/,/g, "");
  return [...s.matchAll(/\d+(?:\.\d+)?/g)]
    .map((m) => parseFloat(m[0]))
    .filter((n) => !isNaN(n) && n > 0 && (skipYearFilter || !isYearLike(n)));
}

// ── Free-text summary lines ───────────────────────────────────────────────
// Physicians sometimes type the month's totals as prose at the bottom of the
// sheet ("รวม =  3260") instead of leaving them in numeric cells. Those cells
// are invisible to every numeric pass below — toNum() on the whole string is
// NaN — so the largest plain number elsewhere on the sheet wins instead (an
// observed file reported 1320, a line-item weight, against a real total of
// 3260).
//
// Matching is deliberately split in two, because the separator is what makes
// a match safe:
//   Tier A — "=" or ":" present: take the number right after it, anywhere in
//     the cell. Year-like values are accepted here (the separator already
//     proves intent, and a real total can land in the BE-year range, e.g.
//     2607). The [^=:\d]* guard stops a year earlier in the cell from being
//     read as the total: "สรุป มิย 2569 งานบริการ = 1940" yields nothing,
//     since "สรุป" is not a total label.
//   Tier B — no separator: the whole cell must be exactly <label><number>
//     ("รวม  100"), and year-like values are rejected. Both guards are needed
//     — without them "จำนวนรวม 74" (a count), "รวมแต้ม 30 วัน" and a bare
//     "รวม 2569" all parse as scores.
const SUMMARY_LABEL     = "(?:รวม|ผลรวม|คะแนนรวม|ยอดรวม)";
const SUMMARY_WITH_SEP  = new RegExp(`${SUMMARY_LABEL}[^=:\\d]*[=:]\\s*([\\d,]+(?:\\.\\d+)?)`, "g");
const SUMMARY_BARE      = new RegExp(`^${SUMMARY_LABEL}[^\\d]*?\\s+([\\d,]+(?:\\.\\d+)?)$`);

/**
 * Pull totals out of free-text cells. See the note above for why the two tiers
 * differ in strictness.
 * @param {object[]} rows
 * @returns {number[]} every total stated in prose, in sheet order
 */
function summaryTextCandidates(rows) {
  const results = [];
  for (const row of rows) {
    for (const val of Object.values(row)) {
      if (typeof val !== "string") continue;
      const s = val.replace(/\s+/g, " ").trim();
      if (!s) continue;

      // Tier A — separator present
      const withSep = [...s.matchAll(SUMMARY_WITH_SEP)]
        .map((m) => parseFloat(m[1].replace(/,/g, "")))
        .filter((n) => !isNaN(n) && n > 0);
      if (withSep.length > 0) {
        results.push(...withSep);
        continue;
      }

      // Tier B — label + number and nothing else
      const bare = SUMMARY_BARE.exec(s);
      if (!bare) continue;
      const n = parseFloat(bare[1].replace(/,/g, ""));
      if (!isNaN(n) && n > 0 && !isYearLike(n)) results.push(n);
    }
  }
  return results;
}

/** Coerce any cell value to a number. Returns NaN if not numeric. */
function toNum(val) {
  if (val === null || val === undefined || val === "") return NaN;
  if (typeof val === "number")  return val;
  if (typeof val === "boolean") return NaN;
  const s = String(val).trim();
  // Skip ISO date strings — parseFloat("2025-01-15T...") returns 2025
  // which looks like a CE year but slips through isYearLike for out-of-range dates
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return NaN;
  return parseFloat(s.replace(/,/g, ""));
}

/**
 * Collect all positive, non-year numbers from a set of rows.
 * NOTE: row-ID filtering is intentionally NOT applied here — it caused
 * false negatives when a score value happened to equal the row index.
 * @param {object[]} rows
 * @param {boolean} [skipYearFilter] - when true, accept numbers in the year range
 *   (used for confirmed grand-total label rows where the score itself may be year-like)
 */
function collectCandidates(rows, skipYearFilter = false) {
  const results = [];
  for (const row of rows) {
    for (const val of Object.values(row)) {
      const n = toNum(val);
      if (isNaN(n) || n <= 0) continue;
      if (!skipYearFilter && isYearLike(n)) continue;
      results.push(n);
    }
  }
  return results;
}

// ── Declared score column ─────────────────────────────────────────────────
// The standard P4P sheet declares its own total-points column in the header
// row ("ประเภทงาน | กิจกรรม | แต้ม | จำนวนรวม | รวมแต้ม | D1…D31"). When that
// header is present the guessing stops: a number sitting in the declared
// column on a labelled total row IS the total, whatever it looks like. That
// matters because isYearLike() discards 1900–2099 wholesale, so a real total
// of e.g. 1940 was being thrown away and a line-item weight returned instead.
const SCORE_COLUMN_LABELS = ["รวมแต้ม", "รวมคะแนน", "คะแนนรวม", "แต้มรวม"];

/**
 * Find the sheet's total-points column from its header row.
 *
 * A header row is identified by being entirely non-numeric — any numeric cell
 * means the row is data, not a header. Without that check a grand-total row
 * ("รวมแต้มทั้งหมด | 11011.5") would nominate its own label column, and the
 * real total would then be read from the wrong place. The label must match a
 * header exactly, not as a substring, for the same reason.
 *
 * @param {object[]} rows
 * @returns {string|null} the column key (e.g. "col_5"), or null when the sheet
 *   declares no such column — in which case every caller keeps its old behaviour.
 */
function findScoreColumn(rows) {
  for (const row of rows) {
    const entries = Object.entries(row)
      .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== "");
    if (entries.length < 3) continue;
    if (entries.some(([, v]) => !isNaN(toNum(v)))) continue;

    const hit = entries.find(([, v]) =>
      SCORE_COLUMN_LABELS.some((label) => stripSpace(String(v)) === stripSpace(label))
    );
    if (hit) return hit[0];
  }
  return null;
}

/** The declared-column value for a row, or NaN when there isn't a usable one. */
function declaredScore(row, scoreCol) {
  if (!scoreCol) return NaN;
  const n = toNum(row[scoreCol]);
  return !isNaN(n) && n > 0 ? n : NaN;
}

/**
 * Try keyword label row first, then fall back to the largest valid number
 * in the entire sheet.
 *
 * KEY FIXES vs previous version:
 * 1. Only check the FIRST 3 columns for Thai total labels.
 *    Some sheets have "รวมแต้ม" as a COLUMN HEADER in col_5 — searching
 *    all columns causes a false match on the header row (day numbers 1–31).
 * 2. Collect candidates from ALL matching label rows (not just the first).
 *    Return the max across all of them — the grand total is always the
 *    largest of all sub-totals.
 * @param {object[]} rows
 * @returns {{ score: number|null, method: string }}
 */
export function extractScoreFromRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { score: null, method: "no rows" };
  }

  // Which column the sheet itself calls the total-points column (null if none).
  const scoreCol = findScoreColumn(rows);

  // Step 1: grand-total pass — search ALL columns for grand-total specific labels.
  // These keywords only appear in grand-total rows, never as column headers.
  const grandCandidates = [];
  for (const row of rows) {
    const allValues = Object.values(row).map((v) => String(v ?? ""));
    const labelCells = allValues.filter((s) =>
      GRAND_TOTAL_LABELS.some((label) => includesLabel(s, label))
    );
    if (labelCells.length > 0) {
      // The declared column wins outright when the sheet has one: no year
      // filter, no Math.max across unrelated cells in the row.
      const declared = declaredScore(row, scoreCol);
      if (!isNaN(declared)) {
        grandCandidates.push(declared);
        continue;
      }
      // Prefer non-year-like candidates first: a confirmed grand-total row can
      // still contain an unrelated year reference in another cell (e.g. a
      // "ปี 2568" note sharing the row), and blindly allowing year-like values
      // for the WHOLE row let that coincidental year outrank the real
      // (possibly smaller) total via Math.max below. Only fall back to
      // year-like candidates when the row has no non-year-like number at all
      // — i.e. the real total itself lands in the BE-year integer range
      // (e.g. 2607).
      const nonYearNums = collectCandidates([row], false);
      const nums = nonYearNums.length > 0 ? nonYearNums : collectCandidates([row], true);
      // Also extract numbers embedded inside the label cells themselves.
      // Handles the case where label and score share one cell, e.g.:
      //   "รวมทั้งหมด  = 11011.5"
      // Safe to skip the year filter here regardless — these numbers come
      // from the label cell's own text, not an unrelated cell in the row.
      const embedded = labelCells.flatMap((s) => numsFromText(s, true));
      grandCandidates.push(...nums, ...embedded);
    }
  }
  if (grandCandidates.length > 0) {
    return { score: Math.max(...grandCandidates), method: "grand-total label row (all columns)" };
  }

  // Step 1b: free-text summary pass — totals typed as prose ("รวม =  3260")
  // rather than left in numeric cells. Ranked above the sub-total pass: a
  // stated total outranks any sub-total the numeric passes can reach, and the
  // labels here are total labels, not line-item ones.
  const summaryCandidates = summaryTextCandidates(rows);
  if (summaryCandidates.length > 0) {
    return { score: Math.max(...summaryCandidates), method: "free-text summary line" };
  }

  // Step 2: sub-total pass — search col_1/col_2/col_3 only.
  // Limited to first 3 columns to avoid false-matching "รวมแต้ม" column headers.
  // Returns the MAX across all matching rows — grand total > any sub-total.
  const subCandidates = [];
  for (const row of rows) {
    const firstThree = ["col_1", "col_2", "col_3"]
      .map((k) => String(row[k] ?? ""));
    const hasLabel = firstThree.some((s) =>
      SUBTOTAL_LABELS.some((label) => includesLabel(s, label))
    );
    if (hasLabel) {
      // Same as the grand-total pass: the declared column beats guessing.
      // A sub-total row often carries a count alongside the points (e.g.
      // "รวม | 74 | 1940"), and with the year filter dropping 1940 the count
      // was the only survivor.
      const declared = declaredScore(row, scoreCol);
      if (!isNaN(declared)) {
        subCandidates.push(declared);
        continue;
      }
      const nums = collectCandidates([row]);
      subCandidates.push(...nums);
    }
  }
  if (subCandidates.length > 0) {
    const subMax = Math.max(...subCandidates);
    // Sanity-check: if the sheet has a larger number than any labeled sub-total row,
    // the grand total is likely in a row whose label sits in col_4+ (not col_1-3).
    // Prefer the sheet-wide max in that case.
    const allNums = collectCandidates(rows);
    const sheetMax = allNums.length > 0 ? Math.max(...allNums) : subMax;
    if (sheetMax > subMax) {
      return { score: sheetMax, method: "largest in sheet (exceeds sub-total label rows)" };
    }
    return { score: subMax, method: "sub-total label row (col_1-3)" };
  }

  // Step 3: largest valid number in the whole sheet
  const all = collectCandidates(rows);
  if (all.length > 0) {
    return { score: Math.max(...all), method: "largest in sheet" };
  }

  // Step 3b: same scan, but allow year-like integers (2400–2699) too. Reached
  // only when Step 3 found nothing at all — i.e. every number in the sheet
  // was excluded solely for looking like a year. A legitimate whole-number
  // score can land in that range (e.g. 2550), and without this fallback it
  // would be silently discarded in favour of the much weaker weight×day
  // computation below (or "no candidates found").
  const allIncludingYearLike = collectCandidates(rows, true);
  if (allIncludingYearLike.length > 0) {
    return { score: Math.max(...allIncludingYearLike), method: "largest in sheet (year-like fallback)" };
  }

  // Step 4: weight × day-count computation (last resort for cm="1" formula-only sheets)
  let computedTotal = 0;
  for (const row of rows) {
    const isLabel = ["col_1", "col_2", "col_3"]
      .some((k) => TOTAL_LABELS.some((label) => includesLabel(String(row[k] ?? ""), label)));
    if (isLabel) continue;

    const weightRaw = row["col_3"];
    if (weightRaw === null || weightRaw === undefined) continue;

    let weight;
    if (typeof weightRaw === "number") {
      weight = weightRaw;
    } else {
      const m = String(weightRaw).replace(/,/g, "").match(/^(\d+\.?\d*)/);
      if (!m) continue;
      weight = parseFloat(m[1]);
    }
    if (isNaN(weight) || weight <= 0) continue;

    let daySum = 0;
    for (let d = 6; d <= 36; d++) {
      const v = toNum(row[`col_${d}`]);
      if (!isNaN(v) && v > 0) daySum += v;
    }
    if (daySum > 0) computedTotal += weight * daySum;
  }

  if (computedTotal > 0) {
    return { score: computedTotal, method: "weight × day-count computation" };
  }

  return { score: null, method: "no candidates found" };
}

/**
 * Wraps extractScoreFromRows with a two-tier fallback for files where
 * fix_p4p_score.py (openpyxl) wrote =SUM(...) formulas without caching
 * a <v> value. In those files the grand-total cell parses as empty, so
 * extractScoreFromRows falls back to the largest plain number in the sheet
 * (often a per-item weight like 2200) instead of the actual grand total.
 *
 * Tier 1 — grand-total row empty, all sub-total rows cached:
 *   Sum the max value from each sub-total row.
 *
 * Tier 2 — some sub-total rows also uncached:
 *   Detect the score column (last numeric column) from whichever sub-total
 *   rows are populated, then sum that column from individual data rows only
 *   (sub-total and grand-total rows are excluded to avoid double-counting).
 */
export function resolveScore(rows) {
  const { score: jsScore, method: jsMethod } = extractScoreFromRows(rows);

  // Detect: grand-total label row present but contains no numbers
  const grandRowEmpty = rows.some((row) => {
    const allVals = Object.values(row).map((v) => String(v ?? ""));
    const hasLabel = allVals.some((s) => GRAND_TOTAL_LABELS.some((lbl) => includesLabel(s, lbl)));
    if (!hasLabel) return false;
    // Check for any cached positive number in this row at all — including
    // year-like ones. This is only asking "did the formula cell fail to cache
    // a <v> value", not "is the value a plausible score" (extractScoreFromRows
    // already handles that distinction correctly for the row it picks). A
    // real score that happens to land in the year-like range (e.g. 2008) is
    // still a cached value, so the row is not "empty".
    return !Object.values(row).some((val) => {
      const n = toNum(val);
      return !isNaN(n) && n > 0;
    });
  });

  if (!grandRowEmpty) return { score: jsScore, method: jsMethod };

  const isSubtotalRow = (row) => {
    const firstThree = ["col_1", "col_2", "col_3"].map((k) => String(row[k] ?? ""));
    return firstThree.some((s) => SUBTOTAL_LABELS.some((lbl) => includesLabel(s, lbl)));
  };
  const isGrandTotalRow = (row) =>
    Object.values(row).some((v) => GRAND_TOTAL_LABELS.some((lbl) => includesLabel(String(v ?? ""), lbl)));

  const rowNums = (row) =>
    Object.values(row).map(toNum).filter((n) => !isNaN(n) && n > 0 && !isYearLike(n));

  const populated = rows.filter((r) => isSubtotalRow(r) && rowNums(r).length > 0);
  const empty     = rows.filter((r) => isSubtotalRow(r) && rowNums(r).length === 0);

  // Tier 1: sum max from each populated sub-total row
  const subtotalSum = populated.reduce((s, r) => s + Math.max(...rowNums(r)), 0);

  // Tier 2: when some sub-totals are also uncached, sum score column from data rows
  let dataRowSum = 0;
  if (populated.length > 0 && empty.length > 0) {
    let scoreColIndex = -1;
    for (const row of populated) {
      const indices = Object.keys(row)
        .filter((k) => /^col_\d+$/.test(k) && !isNaN(toNum(row[k])) && toNum(row[k]) > 0)
        .map((k) => parseInt(k.slice(4)));
      if (indices.length > 0) scoreColIndex = Math.max(scoreColIndex, Math.max(...indices));
    }
    if (scoreColIndex > 0) {
      const scoreColKey = `col_${scoreColIndex}`;
      for (const row of rows) {
        if (isSubtotalRow(row) || isGrandTotalRow(row)) continue;
        const n = toNum(row[scoreColKey]);
        if (!isNaN(n) && n > 0 && !isYearLike(n)) dataRowSum += n;
      }
    }
  }

  const best = Math.max(subtotalSum, dataRowSum);
  if (best > 0 && best > (jsScore ?? 0)) {
    const method = dataRowSum >= subtotalSum
      ? "sum of score-column data rows (sub-totals partially uncached)"
      : "sum of sub-total rows (grand-total formula uncached)";
    return { score: best, method };
  }

  return { score: jsScore, method: jsMethod };
}

/**
 * @param {object} jsonData  { _email_subject, _email_body, _source_file, rows[] }
 * @param {string} filename
 * @returns {Promise<{ name: string, date: string, score: number }>}
 */
export async function analyseJson(jsonData, filename = "data.json") {
  const client    = getClient();
  const rows      = jsonData.rows ?? [];
  const subject   = jsonData._email_subject ?? "";
  const body      = jsonData._email_body    ?? "";
  const file      = jsonData._source_file   ?? filename;
  const emailDate = jsonData._email_date    ?? null;

  if (rows.length === 0) throw new Error("No rows to analyse.");

  // Resolve physician name: filename → subject → body → null (fall back to sheet)
  const resolvedName = resolvePhysicianName(file, subject, body);
  const nameHint = resolvedName
    ? `Pre-resolved name (from filename/subject/body): "${resolvedName}"  ← USE THIS VALUE, strip titles if still present.`
    : `Name not pre-detected — search in order: (1) filename "${file}", (2) email subject/body, (3) row data.`;
  console.log(`│        👤  JS name pre-scan: ${resolvedName ?? "null (will use sheet)"}`);

  // Resolve BE year across subject/body/filename/row-data, picking the newest
  // (largest) year among all sources — a stale year in one source (e.g. an
  // email subject copy-pasted from a previous month) must not shadow a
  // newer, more reliable year found in the filename or sheet content.
  let resolvedBE = resolveBeYear(file, subject, body);
  const rowsBE = resolveBeYearFromRows(rows);
  if (rowsBE) console.log(`│        📅  JS year from row data: ${rowsBE}`);
  if (rowsBE && (!resolvedBE || rowsBE > resolvedBE)) resolvedBE = rowsBE;
  if (!resolvedBE && emailDate) {
    resolvedBE = resolveBeYear(file, subject, body, emailDate);
    if (resolvedBE) console.log(`│        📅  JS year from email received date: ${resolvedBE}`);
  }
  const yearHint   = resolvedBE
    ? `Pre-resolved BE year: ${resolvedBE}  ← USE THIS EXACT VALUE, do not recalculate.`
    : `BE year: unknown — use "0000".`;

  // Resolve score in JS first — gives Claude a reliable anchor
  // Use resolveScore (not extractScoreFromRows directly) so that files where
  // fix_p4p_score.py wrote uncached =SUM(...) formulas fall through the
  // two-tier fallback instead of returning the largest plain number (e.g. 2200).
  const { score: jsScore, method: jsMethod } = resolveScore(rows);
  console.log(`│        🔢  JS score pre-scan: ${jsScore !== null ? jsScore.toFixed(2) : "null"} (${jsMethod})`);

  const scoreHint = jsScore !== null
    ? `Pre-detected score (JS, method: ${jsMethod}): ${jsScore.toFixed(2)}  ← USE THIS VALUE.`
    : `No score pre-detected — find it from the label row or column sum.`;

  // Compact rows — drop all-null rows and null cells before sending to Claude
  const compactRows = rows
    .filter((row) => Object.values(row).some((v) => v !== null))
    .map((row) => Object.fromEntries(
      Object.entries(row).filter(([, v]) => v !== null)
    ));

  const fullJson = JSON.stringify(compactRows, null, 2);
  if (fullJson.length > MAX_ROW_JSON_CHARS) {
    console.warn(`│        ⚠️  Row JSON truncated: ${fullJson.length} → ${MAX_ROW_JSON_CHARS} chars (${compactRows.length} rows)`);
  }
  const rowsJson = fullJson.slice(0, MAX_ROW_JSON_CHARS);

  const bodyPreview = body.trim().slice(0, 400); // trimmed — avoid injecting leading whitespace

  const prompt = `You are analysing a Thai physician physical workload scorecard exported from Excel.
Return ONLY this JSON, nothing else:
{"name": "PHYSICIAN_NAME", "date": "xxxx_xx", "score": "TOTAL"}

━━ 1. name ━━
${nameHint}
Firstname + " " + lastname only. Strip all titles: นพ. พญ. นายแพทย์ แพทย์หญิง ทพ. ดร. Dr. Prof. Mr. Mrs.
IMPORTANT: Thai month names are NOT lastnames — ignore them: มกราคม กุมภาพันธ์ มีนาคม เมษายน พฤษภาคม มิถุนายน กรกฎาคม สิงหาคม กันยายน ตุลาคม พฤศจิกายน ธันวาคม
IMPORTANT: The word "เดือน" means "month" in Thai — it is NEVER a lastname. Do NOT use it as a name component.
If the pre-resolved name above is a single firstname (no space), the physician may have only one name — do NOT search row data for a lastname and do NOT append "เดือน" or any month-related word.
If pre-resolved name above is provided, use it as-is. Otherwise search: (1) filename, (2) subject/body, (3) row data.

━━ 2. date ━━
${yearHint}

Month sources — Subject: "${subject}" | Body: "${bodyPreview}" | Filename: "${file}"
Priority: (1) subject/body, (2) filename, (3) row data.
ม.ค./มค/มกราคม/Jan/January=01    ก.พ./กพ/กุมภาพันธ์/Feb/February=02
มี.ค./มีค/มีนาคม/Mar/March=03     เม.ย./เมย/เมษ/เมษา/เมษายน/Apr/April=04
พ.ค./พค/พฤษภาคม/May=05            มิ.ย./มิย/มิถุนายน/Jun/June=06
ก.ค./กค/กรกฎาคม/Jul/July=07      ส.ค./สค/สิงหาคม/Aug/August=08
ก.ย./กย/กันยายน/Sep/September=09  ต.ค./ตค/ตุลาคม/Oct/October=10
พ.ย./พย/พฤศจิกายน/Nov/November=11 ธ.ค./ธค/ธันวาคม/Dec/December=12
Format: "xxxx_xx". Unknown month → "00".

━━ 3. score ━━
${scoreHint}
If you find a Thai total label row (รวมคะแนน รวมแต้ม คะแนนรวม ผลรวม รวมทั้งหมด รวม), use the largest non-zero numeric value from it.
Format: 2 decimal places, no commas.

━━ Row data ━━
${rowsJson}`;

  const message = await client.messages.create({
    model     : process.env.CLAUDE_MODEL || "claude-sonnet-4-5",
    max_tokens: CLAUDE_MAX_TOKENS,
    messages  : [{ role: "user", content: prompt }],
  });

  if (!Array.isArray(message?.content)) {
    throw new Error(
      `Claude API returned unexpected response (content=${JSON.stringify(message?.content ?? null)}). ` +
      `stop_reason=${message?.stop_reason ?? "unknown"}`
    );
  }
  const raw = message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    throw new Error(`Claude returned non-JSON: ${raw}`);
  }

  // Validate name
  const name = parsed?.name;
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error(`Missing or empty "name": ${raw}`);
  }

  // Validate date format xxxx_xx and semantic range
  const date = parsed?.date;
  if (typeof date !== "string" || !/^\d{4}_\d{2}$/.test(date)) {
    throw new Error(`Invalid date format "${date}" — expected xxxx_xx: ${raw}`);
  }
  const [yr, mo] = date.split("_").map(Number);
  if (yr < 2400 || yr > 2700 || mo < 1 || mo > 12) {
    throw new Error(`Date "${date}" out of valid range (BE year 2400–2700, month 01–12): ${raw}`);
  }

  // Score: prefer Claude's answer; fall back to JS if Claude returns 0/null
  const rawScore = parsed?.score;
  let numeric = 0;
  if (rawScore !== undefined && rawScore !== null && rawScore !== "null") {
    numeric = typeof rawScore === "number"
      ? rawScore
      : parseFloat(String(rawScore).replace(/,/g, ""));
  }
  if (isNaN(numeric) || numeric <= 0) {
    if (jsScore !== null && jsScore > 0) {
      console.log(`│        ⚠️  Claude returned "${rawScore}" — using JS score ${jsScore.toFixed(2)} (${jsMethod})`);
      numeric = jsScore;
    } else {
      throw new Error(
        `Could not determine score. Claude: "${rawScore}", JS scan: null (${jsMethod}). ` +
        `Row count: ${rows.length}. Sample values: ${
          rows.slice(0, 3).map(r => JSON.stringify(Object.values(r).slice(0, 4))).join(" | ")
        }`
      );
    }
  }

  // Return score as a number — callers format with .toFixed(2) for display
  return { name: name.trim(), date, score: numeric };
}
