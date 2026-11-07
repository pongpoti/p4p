#!/usr/bin/env node
/**
 * P4P Excel Merge + SK03 Pipeline
 * Step 1  — 6-month candidate window in BE format
 * Step 2  — Google Drive: find month folder, list Excel files
 * Step 3  — Supabase: fetch person list + metadata
 * Step 4  — Compare Drive vs Supabase lists
 * Step 5  — Merge individual Excel files → one workbook per person sheet
 * Step 6  — Create SK03 Google Spreadsheet via Sheets API (mirrors GAS doPost)
 *           Pay uses the new formula (./sk03-formula.ts): interns first, then
 *           staff by department budget (table on the staff sheet, V33:AF52),
 *           laid out like the new-formula SK03 workbooks of 2026-11-05.
 *           The month's total budget (staff W9) and perP4P (intern U9) come
 *           from ./sk03-budget-inputs.json (see ./budget-inputs.ts); a month
 *           not listed there stays at 0, so its pay shows 0.
 *
 * Each run targets the latest 2 complete months (a fixed top-2 scan, not
 * unbounded backlog-hunting): Phase A walks the window newest → oldest,
 * skipping — not stopping at — incomplete months to keep looking older,
 * until 2 complete months are found or the window is exhausted. Phase B
 * processes each of those independently, so a null-scores or merge-failure
 * outcome on one never blocks the other. The merged workbook and SK03
 * spreadsheet are regenerated and overwritten in place on EVERY run for
 * each complete month — there is no dedup guard, so a repeat trigger (the
 * daily cron firing again, or a manual workflow_dispatch) always refreshes
 * the output from the current Drive + Supabase data.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { drive_v3, sheets_v4 } from 'googleapis';
import type { DriveFile, MonthInfo } from './types';

require('dotenv').config();

const { google }        = require('googleapis') as typeof import('googleapis');
const { createClient }  = require('@supabase/supabase-js') as typeof import('@supabase/supabase-js');
const { Readable }      = require('stream') as typeof import('stream');
const fs                = require('fs') as typeof import('fs');
const os                = require('os') as typeof import('os');
const path              = require('path') as typeof import('path');
const { spawnSync }     = require('child_process') as typeof import('child_process');
const ExcelJS           = require('exceljs') as typeof import('exceljs');
const {
  log, sleep, withRetry, stripExt, normaliseName,
  createAuth, createDriveClient, driveListAll, listFolders, listExcelFiles,
} = require('./lib') as typeof import('./lib');
const {
  DATA_START, STAFF_HEADERS, INTERN_HEADERS, STAFF_PANEL, INTERN_PANEL,
  TABLE_HEAD, TABLE_FIRST, TABLE_LAST, TABLE_TOTAL, TABLE_COLS,
  FMT_BAHT, FMT_INT, FMT_RATIO,
  checkDept, staffRowCells, internRowCells, staffPanel, internPanel, panelWrites,
} = require('./sk03-formula') as typeof import('./sk03-formula');
type CellWrite = import('./sk03-formula').CellWrite;
type PanelRow = import('./sk03-formula').PanelRow;
const { loadBudgetInputs, BUDGET_FILE } = require('./budget-inputs') as typeof import('./budget-inputs');
type BudgetInput = import('./budget-inputs').BudgetInput;

// ═══════════════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════════════
interface Config {
  google: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  };
  supabase: {
    url: string;
    key: string;
  };
  rootFolderId: string;
  outputFolderId: string;
  sk03FolderId: string;
  sk03TemplateId: string; // spreadsheet ID of SK03 template
}

const CONFIG: Config = {
  google: {
    clientId:     process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN!,
  },
  supabase: {
    url: process.env.SUPABASE_URL!,
    key: process.env.SUPABASE_KEY!,
  },
  rootFolderId:   process.env.GOOGLE_ROOT_FOLDER_ID!,
  outputFolderId: process.env.GOOGLE_MERGE_FOLDER_ID!,
  sk03FolderId:   process.env.GOOGLE_SK03_FOLDER_ID!,
  sk03TemplateId: process.env.GOOGLE_SK03_TEMPLATE_ID!,
};

// ─── Thai month names ────────────────────────────────────────────
const THAI_MONTHS: Record<number, string> = {
  1:'มกราคม', 2:'กุมภาพันธ์', 3:'มีนาคม', 4:'เมษายน',
  5:'พฤษภาคม', 6:'มิถุนายน', 7:'กรกฎาคม', 8:'สิงหาคม',
  9:'กันยายน', 10:'ตุลาคม', 11:'พฤศจิกายน', 12:'ธันวาคม',
};

const THAI_MONTH_ABBR: Record<number, string> = {
  1:'ม.ค.', 2:'ก.พ.', 3:'มี.ค.', 4:'เม.ย.',
  5:'พ.ค.', 6:'มิ.ย.', 7:'ก.ค.', 8:'ส.ค.',
  9:'ก.ย.', 10:'ต.ค.', 11:'พ.ย.', 12:'ธ.ค.',
};

// ─── Dept colours & sort order ───────────────────────────────────
// ORDER of keys defines sheet order. INTERN is last.
const DEPT_COLORS: Record<string, string> = {
  'กุมารเวชกรรม':                          '#C8D3B8',
  'จักษุวิทยา':                            '#EEE7D3',
  'จิตเวชและยาเสพติด':                     '#D9B4E2',
  'เทคนิคการแพทย์และพยาธิวิทยาคลินิก':     '#F7D5C2',
  'นิติเวช':                               '#B1D1E3',
  'พยาธิวิทยากายวิภาค':                    '#BEAFE1',
  'ผู้ป่วยนอก':                             '#EAD7C3',
  'รังสีวิทยา':                             '#B0E0E6',
  'วิสัญญีวิทยา':                           '#FFFAE6',
  'เวชกรรมฟื้นฟู':                          '#F3BBDC',
  'เวชกรรมสังคม':                           '#DAEDF7',
  'เวชศาสตร์ฉุกเฉิน':                       '#9ACFC4',
  'ศัลยกรรม':                              '#FFE5EC',
  'ศัลยกรรมออร์โธปิดิกส์':                  '#CFDFEF',
  'สูติ-นรีเวชกรรม':                        '#F9ECD9',
  'โสต ศอ นาสิก':                           '#FADA5E',
  'อาชีวเวชกรรม':                           '#FFDDE4',
  'อายุรกรรม':                              '#A3DDBD',
  'INTERN':                               '#ECC1D1',
};

// ─── Data shapes ──────────────────────────────────────────────────

/** A physician row as read from a monthly Supabase roster table
 *  (public."<BEyear>_<MM>"), normalised by getSupabaseMonthData(). */
interface SupabasePerson {
  fullname: string;
  firstname: string;
  lastname: string;
  department: string;
  prefix: string;
  position: string;
  level: string;
  rank: string;
  type: string;
  std_score: number;
  boss_score: number;
  perf_score: number;
  score: number | null;      // overrides perf_score in col J when not null
  index: number | string | null;
}

/** A row from the management_stipends table (see automation/sql/management_stipends.sql). */
interface ManagementStipendRow {
  physician_name: string;
  remark: string | null;
  amount: number | null;
  is_dept_head: boolean;
}

interface MgmtEntry {
  remark: string | null;
  amount: number | null;
}

// ─── Management allowance data ───────────────────────────────────
// Key: firstname + " " + lastname (no prefix). Provides col M (staff) and col E + I (dept).
//
// Sourced from the Supabase management_stipends table (see
// automation/sql/management_stipends.sql), not hardcoded — this used to be
// a literal array/set of real physicians' names, roles, and stipend
// amounts committed straight into source. loadManagementStipends() below
// populates these two module-level bindings once per run, before any
// month is processed (see main()); everything else in this file
// (getMgmt(), DEPT_HEAD_SET.has(...)) is unchanged.
let MGMT_LOOKUP: Record<string, MgmtEntry> = {};
let DEPT_HEAD_SET: Set<string> = new Set();

/**
 * Fetch management_stipends and populate MGMT_LOOKUP / DEPT_HEAD_SET.
 * Call once per run (not once per month — this data isn't month-specific).
 */
async function loadManagementStipends(supabase: SupabaseClient): Promise<void> {
  const { data, error } = await supabase
    .from('management_stipends')
    .select('physician_name, remark, amount, is_dept_head');
  if (error) throw new Error(`management_stipends read error: ${error.message}`);

  const rows = (data ?? []) as ManagementStipendRow[];
  MGMT_LOOKUP = Object.fromEntries(
    rows.map(d => [normaliseName(d.physician_name), { remark: d.remark, amount: d.amount }])
  );
  DEPT_HEAD_SET = new Set(
    rows.filter(d => d.is_dept_head).map(d => normaliseName(d.physician_name))
  );
  log(`  [Mgmt] Loaded ${rows.length} management_stipends row(s), ${DEPT_HEAD_SET.size} dept-head(s)`);
}

/** Return management entry for a person, or null */
function getMgmt(person: { firstname: string; lastname: string }): MgmtEntry | null {
  const key = normaliseName(`${person.firstname} ${person.lastname}`);
  return MGMT_LOOKUP[key] ?? null;
}

const DEPT_ORDER: Record<string, number> = Object.fromEntries(Object.keys(DEPT_COLORS).map((k, i) => [k, i]));
const DEPT_ORDER_MAX = Object.keys(DEPT_COLORS).length;

// ─── Supabase column name mapping ────────────────────────────────
const SB = {
  prefix:    'prefix',
  position:  'position',
  level:     'level',
  rank:      'rank',            // col F in staff sheet and col C suffix in dept sheets
  type:      'type',             // col G in staff/intern sheet, col D in dept sheets
  std:       'standard_score',
  boss:      'boss_score',
  perf:      'performance_score', // fallback col J
  score:     'score',               // col J override — used when not null
  index:     'index',           // for updateSupabaseRowNum
};

// ═══════════════════════════════════════════════════════════════════
//  STEP 1 — 6-month window
// ═══════════════════════════════════════════════════════════════════
function getTargetMonths(): MonthInfo[] {
  const now = new Date();
  return Array.from({ length: 6 }, (_, i) => {
    const d      = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const beYear = d.getFullYear() + 543;
    const month  = d.getMonth() + 1;
    const key    = `${beYear}_${String(month).padStart(2, '0')}`;
    return { key, beYear, month };
  });
}

// ═══════════════════════════════════════════════════════════════════
//  Utility
// ═══════════════════════════════════════════════════════════════════
// stripExt, normaliseName, log, sleep, withRetry, createAuth,
// createDriveClient, driveListAll, listFolders, listExcelFiles now live in
// ./lib.ts (shared with report.ts — see that file's header comment).
function toSheetName(name: string): string { return name.replace(/[\\/:?*[\]]/g, '').substring(0, 31).trim(); }

function hexToArgb(hex?: string | null): string | undefined {
  if (!hex) return undefined;
  const c = hex.replace('#', '').toUpperCase();
  return c.length === 6 ? `FF${c}` : undefined;
}

/** Convert #RRGGBB to Sheets API {red, green, blue} (0-1 range) */
function hexToRgb(hex: string): { red: number; green: number; blue: number } {
  const c = hex.replace('#', '');
  return {
    red:   parseInt(c.slice(0, 2), 16) / 255,
    green: parseInt(c.slice(2, 4), 16) / 255,
    blue:  parseInt(c.slice(4, 6), 16) / 255,
  };
}

/**
 * Convert a monthKey (e.g. "2568_12") to the Thai sheet name base
 * used by the GAS scripts (e.g. "ธ.ค. 68"), matching the merge step's key.
 */
function monthKeyToSheetBase(monthKey: string): string {
  const [beYear, monthStr] = monthKey.split('_');
  const month = parseInt(monthStr, 10);
  return `${THAI_MONTH_ABBR[month]} ${beYear.slice(2)}`;  // e.g. "ธ.ค. 68"
}

function sbVal<T>(row: Record<string, unknown>, colName: string, defaultVal: T): T {
  const v = row[colName];
  return (v !== null && v !== undefined && v !== '') ? (v as T) : defaultVal;
}

// ═══════════════════════════════════════════════════════════════════
//  Google API clients
// ═══════════════════════════════════════════════════════════════════
// createAuth/createDriveClient now live in ./lib.ts — createSheetsClient
// stays here since report.ts has no use for a Sheets client.
function createSheetsClient(): sheets_v4.Sheets {
  return google.sheets({ version: 'v4', auth: createAuth() });
}

async function downloadFile(drive: drive_v3.Drive, fileId: string): Promise<Buffer> {
  const res = await withRetry(() => drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' }));
  return Buffer.from(res.data as ArrayBuffer);
}

async function uploadFileToDrive(
  drive: drive_v3.Drive,
  folderId: string,
  fileName: string,
  buffer: Buffer
): Promise<drive_v3.Schema$File> {
  const mime     = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const safeName = fileName.replace(/'/g, "\\'");
  const existing = await driveListAll(drive, {
    q: `'${folderId}' in parents and name='${safeName}' and trashed=false`,
    fields: 'nextPageToken, files(id, name)', pageSize: 10,
  });
  if (existing.length > 0) {
    const [first, ...dupes] = existing;
    for (const d of dupes) {
      await withRetry(() => drive.files.delete({ fileId: d.id! }));
      log(`  [Drive] Deleted duplicate id: ${d.id}`, 'warn');
    }
    log(`  [Drive] Overwriting "${fileName}" (id: ${first.id})`);
    const res = await withRetry(() => drive.files.update({
      fileId: first.id!,
      requestBody: { name: fileName },
      media: { mimeType: mime, body: Readable.from([buffer]) },
      fields: 'id, name, webViewLink',
    }));
    return res.data;
  }
  const res = await withRetry(() => drive.files.create({
    requestBody: { name: fileName, parents: [folderId], mimeType: mime },
    media: { mimeType: mime, body: Readable.from([buffer]) },
    fields: 'id, name, webViewLink',
  }));
  return res.data;
}

// ═══════════════════════════════════════════════════════════════════
//  STEP 2 — Google Drive: find month folder
// ═══════════════════════════════════════════════════════════════════
interface DriveMonthData {
  names: string[];
  files: DriveFile[];
  folderId: string;
}

async function getDriveMonthData(drive: drive_v3.Drive, { beYear, month }: MonthInfo): Promise<DriveMonthData | null> {
  const yearFolders = await listFolders(drive, CONFIG.rootFolderId);
  const yearFolder  = yearFolders.find(f => f.name === String(beYear));
  if (!yearFolder) { log(`  [Drive] Year folder "${beYear}" not found`, 'warn'); return null; }

  const thai       = THAI_MONTHS[month];
  const candidates = [`${month} - ${thai}`, `${String(month).padStart(2,'0')} - ${thai}`];
  const monthFolders = await listFolders(drive, yearFolder.id!);
  const monthFolder  = monthFolders.find(f => candidates.includes(f.name!));
  if (!monthFolder) { log(`  [Drive] Month folder not found (tried: ${candidates.join(' | ')})`, 'warn'); return null; }

  const files = await listExcelFiles(drive, monthFolder.id!);
  if (files.length === 0) { log(`  [Drive] No Excel files in "${monthFolder.name}"`, 'warn'); return null; }

  const names = files.map(f => normaliseName(stripExt(f.name!)));
  return { names, files, folderId: monthFolder.id! };
}

// ═══════════════════════════════════════════════════════════════════
//  STEP 3 — Supabase
// ═══════════════════════════════════════════════════════════════════
async function getSupabaseMonthData(supabase: SupabaseClient, tableKey: string): Promise<SupabasePerson[] | null> {
  const { data, error } = await supabase.from(tableKey).select('*');
  if (error) {
    if (error.code === '42P01' || error.message?.includes('does not exist')) {
      log(`  [Supabase] Table "${tableKey}" not found`, 'warn'); return null;
    }
    throw new Error(`Supabase error (${tableKey}): ${error.message}`);
  }
  if (!data || data.length === 0) { log(`  [Supabase] Table "${tableKey}" is empty`, 'warn'); return null; }

  return data.map((r: any) => ({
    fullname:   normaliseName(`${r.firstname ?? ''} ${r.lastname ?? ''}`),
    firstname:  r.firstname  ?? '',
    lastname:   r.lastname   ?? '',
    department: (r.department ?? '').trim(),
    prefix:     sbVal(r, SB.prefix,   ''),
    position:   sbVal(r, SB.position, 'นายแพทย์'),
    level:      sbVal(r, SB.level,    ''),
    rank:       sbVal(r, SB.rank,     ''),
    type:       sbVal(r, SB.type,     ''),
    std_score:  sbVal(r, SB.std,      2200),
    boss_score: sbVal(r, SB.boss,     0),
    perf_score: sbVal(r, SB.perf,     0),
    score:      sbVal<number | null>(r, SB.score, null), // overrides perf_score in col J when not null
    index:      sbVal<number | string | null>(r, SB.index, null),
  }));
}

// ═══════════════════════════════════════════════════════════════════
//  STEP 4 — Compare lists
// ═══════════════════════════════════════════════════════════════════
function listsMatch(driveNames: string[], supabasePersons: SupabasePerson[]): boolean {
  const normDrive = driveNames.map(n => normaliseName(n));
  const normSB    = supabasePersons.map(p => normaliseName(p.fullname));
  if (normDrive.length !== normSB.length) {
    log(`  [Compare] Length mismatch — Drive: ${normDrive.length}, Supabase: ${normSB.length}`, 'warn');
    const setSB    = new Set(normSB);
    const setDrive = new Set(normDrive);
    normDrive.forEach(n => { if (!setSB.has(n))    log(`    ✗ Drive but not SB: "${n}"`, 'warn'); });
    normSB.forEach(n   => { if (!setDrive.has(n)) log(`    ✗ SB but not Drive: "${n}"`, 'warn'); });
    return false;
  }
  const s1 = [...normDrive].sort(), s2 = [...normSB].sort();
  let ok = true;
  for (let i = 0; i < s1.length; i++) {
    if (s1[i] !== s2[i]) { log(`  [Compare] Mismatch: "${s1[i]}" ≠ "${s2[i]}"`, 'warn'); ok = false; }
  }
  return ok;
}

// ═══════════════════════════════════════════════════════════════════
//  STEP 4.5 — Fill missing scores from Excel (ported from claude-analyst.js)
// ═══════════════════════════════════════════════════════════════════

// ── Score extraction constants ────────────────────────────────────
const GRAND_TOTAL_LABELS = [
  'รวมแต้มทั้งหมด', 'รวมคะแนนทั้งหมด', 'รวมทั้งสิ้น', 'ยอดรวมทั้งหมด',
  'รวมทั้งหมด', 'คะแนนรวมทั้งหมด',
];
const SUBTOTAL_LABELS = [
  'รวมคะแนน', 'รวมแต้ม', 'คะแนนรวม', 'ผลรวม', 'รวม',
];
const TOTAL_LABELS = [...GRAND_TOTAL_LABELS, ...SUBTOTAL_LABELS];

function isYearLike(n: number): boolean {
  if (n >= 1900 && n <= 2099) return true;
  if (n >= 2400 && n <= 2699 && Number.isInteger(n)) return true;
  return false;
}

function toNum(val: unknown): number {
  if (val === null || val === undefined || val === '') return NaN;
  if (typeof val === 'number')  return val;
  if (typeof val === 'boolean') return NaN;
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return NaN;
  return parseFloat(s.replace(/,/g, ''));
}

function numsFromText(val: unknown): number[] {
  const s = String(val ?? '').replace(/,/g, '');
  return [...s.matchAll(/\d+(?:\.\d+)?/g)]
    .map(m => parseFloat(m[0]))
    .filter(n => !isNaN(n) && n > 0 && !isYearLike(n));
}

function collectScoreCandidates(rows: Record<string, unknown>[]): number[] {
  const results: number[] = [];
  for (const row of rows) {
    for (const val of Object.values(row)) {
      const n = toNum(val);
      if (isNaN(n) || n <= 0 || isYearLike(n)) continue;
      results.push(n);
    }
  }
  return results;
}

interface ScoreResult {
  score: number | null;
  method: string;
}

function extractScoreFromRows(rows: Record<string, unknown>[]): ScoreResult {
  if (!Array.isArray(rows) || rows.length === 0) return { score: null, method: 'no rows' };

  // Pass 1: grand-total labels (search all columns — these never appear as column headers)
  const grandCandidates: number[] = [];
  for (const row of rows) {
    const allValues = Object.values(row).map(v => String(v ?? ''));
    const labelCells = allValues.filter(s => GRAND_TOTAL_LABELS.some(lbl => s.includes(lbl)));
    if (labelCells.length > 0) {
      grandCandidates.push(...collectScoreCandidates([row]));
      grandCandidates.push(...labelCells.flatMap(s => numsFromText(s)));
    }
  }
  if (grandCandidates.length > 0) {
    return { score: Math.max(...grandCandidates), method: 'grand-total label row' };
  }

  // Pass 2: sub-total labels (first 3 columns only — avoids col-header false matches)
  const subCandidates: number[] = [];
  for (const row of rows) {
    const firstThree = ['col_1', 'col_2', 'col_3'].map(k => String(row[k] ?? ''));
    if (firstThree.some(s => SUBTOTAL_LABELS.some(lbl => s.includes(lbl)))) {
      subCandidates.push(...collectScoreCandidates([row]));
    }
  }
  if (subCandidates.length > 0) {
    const subMax  = Math.max(...subCandidates);
    const allNums = collectScoreCandidates(rows);
    const sheetMax = allNums.length > 0 ? Math.max(...allNums) : subMax;
    if (sheetMax > subMax) return { score: sheetMax, method: 'largest in sheet (exceeds sub-total rows)' };
    return { score: subMax, method: 'sub-total label row' };
  }

  // Pass 3: largest valid number in the whole sheet
  const all = collectScoreCandidates(rows);
  if (all.length > 0) return { score: Math.max(...all), method: 'largest in sheet' };

  // Pass 4: weight × day-count (last resort for formula-only sheets)
  let computedTotal = 0;
  for (const row of rows) {
    const isLabel = ['col_1', 'col_2', 'col_3']
      .some(k => TOTAL_LABELS.some(lbl => String(row[k] ?? '').includes(lbl)));
    if (isLabel) continue;
    const weightRaw = row['col_3'];
    if (weightRaw == null) continue;
    let weight = typeof weightRaw === 'number'
      ? weightRaw
      : parseFloat(String(weightRaw).replace(/,/g, '').match(/^(\d+\.?\d*)/)?.[1] ?? 'NaN');
    if (isNaN(weight) || weight <= 0) continue;
    let daySum = 0;
    for (let d = 6; d <= 36; d++) {
      const v = toNum(row[`col_${d}`]);
      if (!isNaN(v) && v > 0) daySum += v;
    }
    if (daySum > 0) computedTotal += weight * daySum;
  }
  if (computedTotal > 0) return { score: computedTotal, method: 'weight × day-count' };

  return { score: null, method: 'no candidates found' };
}

function resolveScore(rows: Record<string, unknown>[]): ScoreResult {
  const { score: jsScore, method: jsMethod } = extractScoreFromRows(rows);

  const isGrandRow = (row: Record<string, unknown>) =>
    Object.values(row).some(v => GRAND_TOTAL_LABELS.some(lbl => String(v ?? '').includes(lbl)));
  const isSubRow = (row: Record<string, unknown>) =>
    ['col_1', 'col_2', 'col_3'].some(k => SUBTOTAL_LABELS.some(lbl => String(row[k] ?? '').includes(lbl)));
  const rowNums = (row: Record<string, unknown>) =>
    Object.values(row).map(toNum).filter(n => !isNaN(n) && n > 0 && !isYearLike(n));

  // Detect: grand-total label row present but holds no numbers (uncached formula)
  const grandRowEmpty = rows.some(row => isGrandRow(row) && rowNums(row).length === 0);
  if (!grandRowEmpty) return { score: jsScore, method: jsMethod };

  const populated = rows.filter(r => isSubRow(r) && rowNums(r).length > 0);
  const empty     = rows.filter(r => isSubRow(r) && rowNums(r).length === 0);

  // Tier 1: sum max from each populated sub-total row
  const subtotalSum = populated.reduce((s, r) => s + Math.max(...rowNums(r)), 0);

  // Tier 2: when some sub-totals also uncached, sum score column from data rows
  let dataRowSum = 0;
  if (populated.length > 0 && empty.length > 0) {
    let scoreColIndex = -1;
    for (const row of populated) {
      const indices = Object.keys(row)
        .filter(k => /^col_\d+$/.test(k) && !isNaN(toNum(row[k])) && toNum(row[k]) > 0)
        .map(k => parseInt(k.slice(4)));
      if (indices.length > 0) scoreColIndex = Math.max(scoreColIndex, Math.max(...indices));
    }
    if (scoreColIndex > 0) {
      const scoreColKey = `col_${scoreColIndex}`;
      for (const row of rows) {
        if (isSubRow(row) || isGrandRow(row)) continue;
        const n = toNum(row[scoreColKey]);
        if (!isNaN(n) && n > 0 && !isYearLike(n)) dataRowSum += n;
      }
    }
  }

  const best = Math.max(subtotalSum, dataRowSum);
  if (best > 0 && best > (jsScore ?? 0)) {
    const method = dataRowSum >= subtotalSum
      ? 'sum of score-column data rows (sub-totals partially uncached)'
      : 'sum of sub-total rows (grand-total formula uncached)';
    return { score: best, method };
  }
  return { score: jsScore, method: jsMethod };
}

/** Convert an Excel buffer to the { col_1, col_2, … } row format used by resolveScore */
async function excelToRows(buffer: Buffer): Promise<Record<string, unknown>[]> {
  const wb = new ExcelJS.Workbook();
  // exceljs's bundled types predate Node 22's generic `Buffer<ArrayBufferLike>`
  // — a real Buffer at runtime, just a structural mismatch against the old type.
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];

  const rows: Record<string, unknown>[] = [];
  ws.eachRow({ includeEmpty: false }, row => {
    const obj: Record<string, unknown> = {};
    row.eachCell({ includeEmpty: true }, (cell, colNum) => {
      let val: unknown = cell.value;
      if (val !== null && typeof val === 'object') {
        const v = val as Record<string, unknown>;
        if (val instanceof Date)           val = val.toISOString();
        else if (v.richText)               val = (v.richText as { text: string }[]).map(r => r.text).join('');
        else if (v.result !== undefined) {
          val = v.result;
          // result itself can be a Date (date formula) or error object {error:'#REF!'}
          if (val instanceof Date)                          val = val.toISOString();
          else if (val !== null && typeof val === 'object') val = null;
        }
        else if (v.formula !== undefined) val = null;  // formula with no cached result
        else if (v.text !== undefined)    val = v.text;
        else                               val = String(val);
      }
      obj[`col_${colNum}`] = val;
    });
    if (Object.values(obj).some(v => v !== null && v !== undefined && v !== '')) {
      rows.push(obj);
    }
  });
  return rows;
}

/** Step 4.5 — for each person with score=null, extract sum score from their Drive Excel */
async function fillMissingScores(
  drive: drive_v3.Drive,
  driveFiles: DriveFile[],
  sbData: SupabasePerson[],
  monthKey: string,
  supabase: SupabaseClient
): Promise<void> {
  const nullScorePersons = sbData.filter(p => p.score === null);
  if (nullScorePersons.length === 0) {
    log('  [Score] All persons already have scores');
    return;
  }
  log(`  [Score] ${nullScorePersons.length} person(s) with null score — extracting from Excel…`);

  const driveMap: Record<string, DriveFile> = {};
  for (const file of driveFiles) {
    driveMap[normaliseName(stripExt(file.name!))] = file;
  }

  let updated = 0;
  for (const person of nullScorePersons) {
    const normName = normaliseName(person.fullname);
    const file = driveMap[normName];
    if (!file) {
      log(`  [Score] ⚠ No Drive file for "${normName}" — skipping`, 'warn');
      continue;
    }
    log(`  [Score] ↓ ${person.fullname}`);
    try {
      const buffer = await downloadFile(drive, file.id!);
      const rows   = await excelToRows(buffer);
      const { score, method } = resolveScore(rows);
      if (score === null || score <= 0) {
        log(`  [Score] ⚠ "${normName}" — could not extract (${method})`, 'warn');
        continue;
      }
      log(`  [Score]   → ${score.toFixed(2)}  (${method})`);

      if (person.index !== null) {
        const { error } = await supabase
          .from(monthKey)
          .update({ [SB.score]: score })
          .eq(SB.index, person.index);
        if (error) {
          log(`  [Score] ⚠ Supabase update failed for "${normName}": ${error.message}`, 'warn');
        } else {
          person.score = score;  // keep sbData consistent for Step 5+
          updated++;
        }
      }
    } catch (err: any) {
      log(`  [Score] ⚠ Error for "${normName}": ${err.message}`, 'warn');
    }
  }
  log(`  [Score] ✓ ${updated}/${nullScorePersons.length} scores extracted and saved`);
}

// ═══════════════════════════════════════════════════════════════════
//  STEP 5 — Merge Excel files (via Python/openpyxl)
// ═══════════════════════════════════════════════════════════════════

type NamedDriveFile = DriveFile & { origName: string; normName: string };

function sortByDeptThenName(a: NamedDriveFile, b: NamedDriveFile, deptMap: Record<string, string>): number {
  const dA   = deptMap[a.normName] ?? '';
  const dB   = deptMap[b.normName] ?? '';
  const idxA = DEPT_ORDER[dA] ?? DEPT_ORDER_MAX;
  const idxB = DEPT_ORDER[dB] ?? DEPT_ORDER_MAX;
  if (idxA !== idxB) return idxA - idxB;
  return a.normName.localeCompare(b.normName, 'th');
}

/** Merge all Excel files → one workbook with one sheet per person (via Python/openpyxl) */
async function mergeAndUpload(
  drive: drive_v3.Drive,
  driveFiles: DriveFile[],
  supabasePersons: SupabasePerson[],
  monthKey: string
): Promise<drive_v3.Schema$File | null> {
  const deptMap: Record<string, string> = {};
  supabasePersons.forEach(p => { deptMap[normaliseName(p.fullname)] = p.department; });

  const filesWithName: NamedDriveFile[] = driveFiles.map(f => ({
    ...f, origName: stripExt(f.name!), normName: normaliseName(stripExt(f.name!)),
  }));
  filesWithName.sort((a, b) => sortByDeptThenName(a, b, deptMap));

  log('\n  [Merge] Sorted order:');
  filesWithName.forEach((f, i) =>
    log(`    ${String(i+1).padStart(2)}. ${f.origName.padEnd(32)} [${deptMap[f.normName] ?? '?'}]`));

  // Create temp directory for this run
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4p_merge_'));
  log(`\n  [Merge] Temp dir: ${tmpDir}`);

  try {
    interface ManifestEntry {
      path: string;
      sheet_name: string;
      tab_color: string;
    }
    const manifestEntries: ManifestEntry[] = [];
    const usedSheetNames  = new Set<string>();

    // Download each file into the temp directory
    for (const file of filesWithName) {
      log(`\n  [Merge] ↓ ${file.origName}`);
      const buffer   = await downloadFile(drive, file.id!);
      const filePath = path.join(tmpDir, `${file.id}.xlsx`);
      fs.writeFileSync(filePath, buffer);

      let sheetName = toSheetName(file.origName);
      if (usedSheetNames.has(sheetName)) {
        let c = 2;
        while (usedSheetNames.has(`${sheetName}_${c}`)) c++;
        const suffix = `_${c}`;
        sheetName = `${sheetName.substring(0, 31 - suffix.length)}${suffix}`;
      }
      usedSheetNames.add(sheetName);

      const dept    = deptMap[file.normName] ?? '';
      const tabArgb = hexToArgb(DEPT_COLORS[dept]) ?? '';
      manifestEntries.push({ path: filePath, sheet_name: sheetName, tab_color: tabArgb });
    }

    if (manifestEntries.length === 0) {
      log('  [Merge] ⚠ No files — nothing to upload', 'warn');
      return null;
    }

    // Write manifest for Python script
    const manifestPath = path.join(tmpDir, 'manifest.json');
    const outputPath   = path.join(tmpDir, 'merged.xlsx');
    fs.writeFileSync(manifestPath, JSON.stringify({ files: manifestEntries }, null, 2), 'utf8');

    // Invoke Python merge script
    const scriptPath = path.join(__dirname, 'merge.py');
    log('\n  [Merge] Running Python/openpyxl merge…');
    const py = spawnSync(
      process.platform === 'win32' ? 'python' : 'python3',
      [scriptPath, manifestPath, outputPath],
      { encoding: 'utf8', stdio: 'pipe' }
    );
    if (py.stdout) log(py.stdout.trimEnd());
    if (py.stderr) log(py.stderr.trimEnd(), 'warn');
    if (py.status !== 0) throw new Error(`merge.py exited with code ${py.status}`);

    // Upload merged file to Drive
    const buf      = fs.readFileSync(outputPath);
    const name     = `merged_${monthKey}.xlsx`;
    const sheetCnt = manifestEntries.length;
    log(`\n  [Merge] Uploading "${name}" — ${sheetCnt} sheets…`);
    const uploaded = await uploadFileToDrive(drive, CONFIG.outputFolderId, name, buf);
    log(`  [Merge] ✓ id: ${uploaded.id}\n           🔗 ${uploaded.webViewLink}`);
    return uploaded;

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    log('  [Merge] Temp dir cleaned up');
  }
}

// ═══════════════════════════════════════════════════════════════════
//  STEP 6 — Create SK03 Google Spreadsheet (mirrors GAS doPost × 3)
//  Sheet order: staff → intern → one per dept (DEPT_COLORS order)
// ═══════════════════════════════════════════════════════════════════

// ─── Sheets API helpers ───────────────────────────────────────────
/** Grid range helper — all indices 0-based, r2/c2 inclusive */
function gridRange(sheetId: number, r1: number, c1: number, r2: number, c2: number): sheets_v4.Schema$GridRange {
  return { sheetId, startRowIndex: r1, endRowIndex: r2 + 1, startColumnIndex: c1, endColumnIndex: c2 + 1 };
}

const SOLID: sheets_v4.Schema$Border = { style: 'SOLID', width: 1 };

function bordersReq(sheetId: number, r1: number, c1: number, r2: number, c2: number, inner = false): sheets_v4.Schema$Request {
  return {
    updateBorders: {
      range: gridRange(sheetId, r1, c1, r2, c2),
      top: SOLID, bottom: SOLID, left: SOLID, right: SOLID,
      ...(inner ? { innerHorizontal: SOLID, innerVertical: SOLID } : {}),
    },
  };
}

// ─── Overall sheet helpers (staff + intern share the same template) ─

/**
 * Build the data rows for an overall (staff/intern) sheet: A..T for staff,
 * A..Q for interns. A..M and O..P mirror the appendRow loop in both GAS
 * scripts. Pay (N) and the helper columns use the new formula — see
 * ./sk03-formula.ts.
 */
function buildOverallRows(persons: SupabasePerson[], S: number, isIntern: boolean, staffSheetName: string): (string | number)[][] {
  const last = S + persons.length - 1;
  return persons.map((p, idx) => {
    const r = S + idx;
    const isDeptHead = DEPT_HEAD_SET.has(normaliseName(`${p.firstname} ${p.lastname}`));
    const staff  = isIntern ? null : staffRowCells(r, p.department, S, last);
    const intern = isIntern ? internRowCells(r, staffSheetName) : null;
    return [
      idx + 1,                                               // A: sequence
      p.prefix    || '',                                     // B
      p.firstname || '',                                     // C
      p.lastname  || '',                                     // D
      p.position  || 'นายแพทย์',                            // E
      p.rank      || '',                                     // F: rank (supabase 'rank')
      p.type      || '',                                     // G: type (supabase 'type')
      p.std_score  ?? 2200,                                  // H
      isDeptHead ? 1320 : 0,                                 // I: dept-head extra score
      (p.score ?? p.perf_score ?? 0) - (isDeptHead ? 1320 : 0), // J: score minus dept-head extra (already in col I)
      `=I${r}+J${r}`,                                       // K
      `=K${r}-H${r}`,                                       // L: E = score above the 2,200 standard
      getMgmt(p)?.amount ?? p.boss_score ?? 0,              // M: mgmt amount or boss score (moved from I)
      staff ? staff.N : intern!.N,                           // N: P4P pay
      `=M${r}+N${r}`,                                       // O
      ' ',                                                   // P: remark
      ...(staff ? staff.QtoT : [intern!.Q]),                 // Q..T (staff) / Q (intern)
    ];
  });
}

/** 0-based column index of a column letter (A → 0). */
function colIdx(letter: string): number {
  return letter.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
}

const INPUT_FILL  = { red: 1, green: 0.949, blue: 0.8 };            // #FFF2CC: cells typed in (or filled from p4p-analysis)
const HEADER_FILL = { red: 0.988, green: 0.894, blue: 0.714 };      // #FCE4B6: new-formula headers
const GRAY        = { red: 0.831, green: 0.831, blue: 0.831 };
const WHITE       = { red: 1, green: 1, blue: 1 };
const COL_Q  = colIdx('Q');
const COL_AF = colIdx('AF');

function numFmtReq(sheetId: number, r1: number, c1: number, r2: number, c2: number, pattern: string): sheets_v4.Schema$Request {
  return { repeatCell: { range: gridRange(sheetId, r1, c1, r2, c2), cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern } } }, fields: 'userEnteredFormat.numberFormat' } };
}

function fillReq(sheetId: number, r1: number, c1: number, r2: number, c2: number, color: sheets_v4.Schema$Color): sheets_v4.Schema$Request {
  return { repeatCell: { range: gridRange(sheetId, r1, c1, r2, c2), cell: { userEnteredFormat: { backgroundColor: color } }, fields: 'userEnteredFormat.backgroundColor' } };
}

function colWidthReq(sheetId: number, col: string, pixelSize: number): sheets_v4.Schema$Request {
  const c = colIdx(col);
  return { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: c, endIndex: c + 1 }, properties: { pixelSize, hiddenByUser: false }, fields: 'pixelSize,hiddenByUser' } };
}

/** Where the month's budget input came from, written next to the yellow input cell. */
function inputNote(input: BudgetInput | undefined): string {
  return input
    ? `จาก ${BUDGET_FILE} (ตาม p4p-analysis formula.md)`
    : `ยังไม่มีเดือนนี้ใน ${BUDGET_FILE} · ค่าตอบแทนเป็น 0 จนกว่าจะเพิ่ม`;
}

/** Last sheet row the new-formula area (columns Q..AF) uses. */
function newAreaLastRow(lastRow: number, isIntern: boolean): number {
  return Math.max(lastRow, isIntern ? 20 : TABLE_TOTAL);
}

/**
 * Clear what the template has in columns Q..AF from row 5 down (the old
 * AVG±SD band headers, thresholds and budget block, with their merges,
 * formats and conditional formats), make sure the grid reaches column AF,
 * then write the new-formula headers, the side panel and (staff) the
 * department table. Staff panel V/W, intern panel T/U, the same cells as the
 * new-formula workbooks.
 */
async function writeOverallMeta(
  sheets: sheets_v4.Sheets,
  ssId: string,
  sheetName: string,
  sheetId: number,
  lastRow: number,
  isIntern: boolean,
  internSheetName: string,
  input: BudgetInput | undefined
): Promise<void> {
  const S = DATA_START;
  const sh = `'${sheetName}'!`;
  const endRow = newAreaLastRow(lastRow, isIntern) + 5; // 1-based, inclusive

  const meta = await withRetry(() => sheets.spreadsheets.get({ spreadsheetId: ssId, fields: 'sheets(properties(sheetId,gridProperties),merges,conditionalFormats)' }));
  const me = meta.data.sheets?.find(s => s.properties?.sheetId === sheetId);
  const grid = me?.properties?.gridProperties ?? {};
  const prep: sheets_v4.Schema$Request[] = [];
  const needCols = COL_AF + 1 - (grid.columnCount ?? 0);
  if (needCols > 0) prep.push({ appendDimension: { sheetId, dimension: 'COLUMNS', length: needCols } });
  const needRows = endRow - (grid.rowCount ?? 0);
  if (needRows > 0) prep.push({ appendDimension: { sheetId, dimension: 'ROWS', length: needRows } });
  // Unmerge every merge from row 5 down that reaches column Q or further
  // (unmerging part of a merge fails, so each is unmerged over its full range).
  for (const m of me?.merges ?? []) {
    if ((m.startRowIndex ?? 0) >= 4 && (m.endColumnIndex ?? 0) > COL_Q) prep.push({ unmergeCells: { range: m } });
  }
  // Drop the template's conditional formats on Q and beyond (old band colours).
  (me?.conditionalFormats ?? [])
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => (rule.ranges ?? []).every(r => (r.startColumnIndex ?? 0) >= COL_Q))
    .reverse()
    .forEach(({ index }) => prep.push({ deleteConditionalFormatRule: { sheetId, index } }));
  // Reset formats in the new-formula area.
  prep.push({ repeatCell: { range: gridRange(sheetId, 4, COL_Q, endRow - 1, COL_AF), cell: {}, fields: 'userEnteredFormat' } });
  await withRetry(() => sheets.spreadsheets.batchUpdate({ spreadsheetId: ssId, requestBody: { requests: prep } }));

  await withRetry(() => sheets.spreadsheets.values.batchClear({
    spreadsheetId: ssId,
    requestBody: { ranges: [`${sh}Q5:AF${endRow}`] },
  }));

  const headers = isIntern ? INTERN_HEADERS : STAFF_HEADERS;
  const cells: CellWrite[] = headers.flatMap(h => [
    { range: `${h.col}5`, values: [[h.text]] },
    { range: `${h.col}7`, values: [[h.letter]] },
  ]);
  if (isIntern) {
    const { panel, extra } = internPanel(S, lastRow, input?.perP4P ?? 0, inputNote(input));
    cells.push(...panelWrites(panel, INTERN_PANEL), ...extra);
  } else {
    const { panel, table } = staffPanel(internSheetName, S, lastRow, input?.budget ?? 0, inputNote(input));
    cells.push(...panelWrites(panel, STAFF_PANEL), ...table);
  }

  await withRetry(() => sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: ssId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: cells.map(c => ({ range: `${sh}${c.range}`, values: c.values })),
    },
  }));
}

/** Format a side panel: grey merged headings, bordered rows, number formats, yellow inputs. */
function panelFormatReqs(sheetId: number, panel: PanelRow[], cols: { label: string; value: string }): sheets_v4.Schema$Request[] {
  const L = colIdx(cols.label);
  const V = colIdx(cols.value);
  const reqs: sheets_v4.Schema$Request[] = [];
  for (const p of panel) {
    const r = p.row - 1;
    if (p.heading) {
      reqs.push({ mergeCells: { range: gridRange(sheetId, r, L, r, V), mergeType: 'MERGE_ALL' } });
      reqs.push({ repeatCell: { range: gridRange(sheetId, r, L, r, V), cell: { userEnteredFormat: { backgroundColor: GRAY, textFormat: { bold: true, fontFamily: 'TH SarabunPSK', fontSize: 14 }, horizontalAlignment: 'CENTER' } }, fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)' } });
      reqs.push(bordersReq(sheetId, r, L, r, V));
      continue;
    }
    if (p.value === undefined) continue; // a plain note line
    reqs.push(bordersReq(sheetId, r, L, r, V, true));
    if (p.fmt) reqs.push(numFmtReq(sheetId, r, V, r, V, p.fmt));
    if (p.input) reqs.push(fillReq(sheetId, r, V, r, V, INPUT_FILL));
  }
  return reqs;
}

/**
 * Apply all formatting for an overall sheet:
 * - J column dept background per row
 * - Number formats (H:O = ###,##0.00, helper columns, panel, table)
 * - Data area borders
 * - New-formula headers (rows 5-6 merged, letter in row 7), yellow input cells, column widths
 * - Side panel and (staff) department table
 */
async function formatOverallSheet(
  sheets: sheets_v4.Sheets,
  ssId: string,
  sheetId: number,
  persons: SupabasePerson[],
  lastRow: number,
  isIntern: boolean,
  internSheetName: string
): Promise<void> {
  const S     = DATA_START;
  const R8    = S - 1;          // 0-based row 8
  const RLast = lastRow - 1;    // 0-based last data row
  const fmtReqs: sheets_v4.Schema$Request[] = [];

  // J column (idx 9): apply dept colour per data row only
  persons.forEach((p, idx) => {
    const hex = DEPT_COLORS[p.department];
    if (!hex) return;
    const ri = S - 1 + idx; // 0-based row
    fmtReqs.push({
      repeatCell: {
        range: gridRange(sheetId, ri, 9, ri, 9),
        cell: { userEnteredFormat: { backgroundColor: hexToRgb(hex) } },
        fields: 'userEnteredFormat.backgroundColor',
      },
    });
  });

  // Extend the grid so the clear range below never exceeds the sheet boundary.
  // This is needed when persons fill the sheet to the template's row limit.
  fmtReqs.push({ appendDimension: { sheetId, dimension: 'ROWS', length: 20 } });

  // Clear J background for rows after last person (template may have residual colours)
  fmtReqs.push({
    repeatCell: {
      range: gridRange(sheetId, RLast + 1, 9, RLast + 20, 9),
      cell: { userEnteredFormat: { backgroundColor: WHITE } },
      fields: 'userEnteredFormat.backgroundColor',
    },
  });

  // Font for the whole new-formula area (Q..AF)
  const areaEnd = newAreaLastRow(lastRow, isIntern) - 1;
  fmtReqs.push({ repeatCell: {
    range: gridRange(sheetId, 4, COL_Q, areaEnd, COL_AF),
    cell: { userEnteredFormat: { textFormat: { fontFamily: 'TH SarabunPSK', fontSize: 14 }, verticalAlignment: 'MIDDLE' } },
    fields: 'userEnteredFormat(textFormat,verticalAlignment)',
  }});

  // New-formula headers: text over rows 5-6, letter in row 7 (0-based 4-6)
  const headers = isIntern ? INTERN_HEADERS : STAFF_HEADERS;
  for (const h of headers) {
    const c = colIdx(h.col);
    fmtReqs.push({ mergeCells: { range: gridRange(sheetId, 4, c, 5, c), mergeType: 'MERGE_ALL' } });
    fmtReqs.push({ repeatCell: {
      range: gridRange(sheetId, 4, c, 6, c),
      cell: { userEnteredFormat: { backgroundColor: HEADER_FILL, textFormat: { bold: true, fontFamily: 'TH SarabunPSK', fontSize: 14 }, horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE', wrapStrategy: 'WRAP' } },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)',
    }});
    fmtReqs.push(bordersReq(sheetId, 4, c, 6, c, true));
  }

  // Data rows: H:O as before, then the helper columns
  fmtReqs.push(numFmtReq(sheetId, R8, 7, RLast, 14, '###,##0.00'));
  if (isIntern) {
    fmtReqs.push(numFmtReq(sheetId, R8, COL_Q, RLast, COL_Q, FMT_RATIO));
    fmtReqs.push(bordersReq(sheetId, R8, COL_Q, RLast, COL_Q, true));
    const { panel } = internPanel(S, lastRow, 0, '');
    fmtReqs.push(...panelFormatReqs(sheetId, panel, INTERN_PANEL));
    fmtReqs.push({ repeatCell: { range: gridRange(sheetId, 8, colIdx('V'), 8, colIdx('V')), cell: { userEnteredFormat: { textFormat: { italic: true, fontSize: 12 } } }, fields: 'userEnteredFormat.textFormat(italic,fontSize)' } });
  } else {
    fmtReqs.push(fillReq(sheetId, R8, COL_Q, RLast, COL_Q, INPUT_FILL));                // แผนก (typed in)
    fmtReqs.push(numFmtReq(sheetId, R8, colIdx('R'), RLast, colIdx('R'), FMT_BAHT));
    fmtReqs.push(numFmtReq(sheetId, R8, colIdx('S'), RLast, colIdx('S'), FMT_RATIO));
    fmtReqs.push(numFmtReq(sheetId, R8, colIdx('T'), RLast, colIdx('T'), FMT_BAHT));
    fmtReqs.push(bordersReq(sheetId, R8, COL_Q, RLast, colIdx('T'), true));
    const { panel } = staffPanel(internSheetName, S, lastRow, 0, '');
    fmtReqs.push(...panelFormatReqs(sheetId, panel, STAFF_PANEL));
    fmtReqs.push({ repeatCell: { range: gridRange(sheetId, 8, colIdx('X'), 8, colIdx('X')), cell: { userEnteredFormat: { textFormat: { italic: true, fontSize: 12 } } }, fields: 'userEnteredFormat.textFormat(italic,fontSize)' } });

    // Department table V33:AF52
    const c0 = colIdx(TABLE_COLS[0]);
    const c1 = colIdx(TABLE_COLS[TABLE_COLS.length - 1]);
    const H = TABLE_HEAD - 1, F = TABLE_FIRST - 1, Lr = TABLE_LAST - 1, T = TABLE_TOTAL - 1;
    const col = (letter: string) => colIdx(letter);
    fmtReqs.push({ repeatCell: {
      range: gridRange(sheetId, H, c0, H, c1),
      cell: { userEnteredFormat: { backgroundColor: HEADER_FILL, textFormat: { bold: true, fontFamily: 'TH SarabunPSK', fontSize: 14 }, horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE', wrapStrategy: 'WRAP' } },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)',
    }});
    fmtReqs.push(bordersReq(sheetId, H, c0, T, c1, true));
    fmtReqs.push(fillReq(sheetId, F, col('Y'), Lr, col('Y'), INPUT_FILL));               // ตัวคูณสาขา (editable)
    fmtReqs.push(numFmtReq(sheetId, F, col('Y'), Lr, col('Y'), '0.00'));
    fmtReqs.push(numFmtReq(sheetId, F, col('Z'), T, col('Z'), FMT_INT));
    fmtReqs.push(numFmtReq(sheetId, F, col('AA'), T, col('AB'), FMT_BAHT));
    fmtReqs.push(numFmtReq(sheetId, F, col('AC'), T, col('AC'), FMT_RATIO));
    fmtReqs.push(numFmtReq(sheetId, F, col('AD'), T, col('AD'), FMT_BAHT));
    fmtReqs.push(numFmtReq(sheetId, F, col('AE'), T, col('AE'), FMT_INT));
    fmtReqs.push(numFmtReq(sheetId, F, col('AF'), T, col('AF'), FMT_BAHT));
    fmtReqs.push({ repeatCell: { range: gridRange(sheetId, F, col('W'), Lr, col('X')), cell: { userEnteredFormat: { horizontalAlignment: 'CENTER' } }, fields: 'userEnteredFormat.horizontalAlignment' } });
    fmtReqs.push({ repeatCell: { range: gridRange(sheetId, T, c0, T, c1), cell: { userEnteredFormat: { backgroundColor: HEADER_FILL, textFormat: { bold: true, fontFamily: 'TH SarabunPSK', fontSize: 14 } } }, fields: 'userEnteredFormat(backgroundColor,textFormat)' } });
  }

  // Data area borders (mirrors GAS: A8:A, B8:D, E8:P with inner)
  fmtReqs.push(bordersReq(sheetId, R8, 0,  RLast, 0));
  fmtReqs.push(bordersReq(sheetId, R8, 1,  RLast, 3));
  fmtReqs.push(bordersReq(sheetId, R8, 4,  RLast, 15, true));

  // Column widths (pixels) for the helper columns, the panel and the table
  const widths: [string, number][] = isIntern
    ? [['Q', 95], ['R', 20], ['S', 20], ['T', 280], ['U', 130], ['V', 330]]
    : [['Q', 230], ['R', 95], ['S', 95], ['T', 105], ['U', 20], ['V', 290], ['W', 130], ['X', 120],
       ['Y', 85], ['Z', 85], ['AA', 100], ['AB', 115], ['AC', 100], ['AD', 105], ['AE', 95], ['AF', 95]];
  widths.forEach(([c, px]) => fmtReqs.push(colWidthReq(sheetId, c, px)));

  await withRetry(() => sheets.spreadsheets.batchUpdate({ spreadsheetId: ssId, requestBody: { requests: fmtReqs } }));
}

/**
 * Append 6 blank rows then signature rows at lastRow+4 and lastRow+5.
 * Mirrors GAS: both staff and intern scripts.
 */
async function writeOverallSignature(
  sheets: sheets_v4.Sheets,
  ssId: string,
  sheetName: string,
  sheetId: number,
  lastRow: number
): Promise<void> {
  const blankRows: string[][] = Array.from({ length: 6 }, () => Array.from({ length: 26 }, () => ' '));
  await withRetry(() => sheets.spreadsheets.values.append({
    spreadsheetId: ssId,
    range: `'${sheetName}'!A${lastRow + 1}`,
    valueInputOption: 'RAW',
    requestBody: { values: blankRows },
  }));

  const sig1 = lastRow + 4;
  const sig2 = lastRow + 5;

  await withRetry(() => sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: ssId,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        { range: `'${sheetName}'!A${sig1}`, values: [['ลงชื่อ................................................................................................................หัวหน้างาน/กลุ่มงาน/งาน']] },
        { range: `'${sheetName}'!A${sig2}`, values: [['(.....................................................................................................................................)']] },
      ],
    },
  }));

  await withRetry(() => sheets.spreadsheets.batchUpdate({
    spreadsheetId: ssId,
    requestBody: {
      requests: [
        { mergeCells: { range: gridRange(sheetId, sig1 - 1, 0, sig1 - 1, 15), mergeType: 'MERGE_ALL' } },
        { mergeCells: { range: gridRange(sheetId, sig2 - 1, 0, sig2 - 1, 15), mergeType: 'MERGE_ALL' } },
        { repeatCell: {
            range: gridRange(sheetId, sig1 - 1, 0, sig2 - 1, 15),
            cell: { userEnteredFormat: { horizontalAlignment: 'CENTER', textFormat: { bold: true } } },
            fields: 'userEnteredFormat(horizontalAlignment,textFormat)',
        }},
        { repeatCell: {
            range: gridRange(sheetId, sig1 - 2, 0, sig2 - 1, 25),
            cell: { userEnteredFormat: { textFormat: { fontFamily: 'TH SarabunPSK', fontSize: 16 } } },
            fields: 'userEnteredFormat.textFormat.fontFamily,userEnteredFormat.textFormat.fontSize',
        }},
      ],
    },
  }));
}

// ─── Department sheets ─────────────────────────────────────────────

/**
 * Build all department sheets from dep_template.
 * Mirrors GAS dep doPost: one sheet per dept in DEPT_COLORS order.
 * Uses rowNumMap to link back to staff/intern sheet row numbers.
 *
 * rowNumMap key: "prefix firstname  lastname" (double space before lastname)
 * rowNumMap value: 1-based row number in staff or intern sheet
 */
async function buildDeptSheets(
  sheets: sheets_v4.Sheets,
  ssId: string,
  depTmplSheetId: number,
  allPersons: SupabasePerson[],
  beYear: number,
  month: number,
  staffSheetName: string,
  internSheetName: string,
  rowNumMap: Record<string, number>
): Promise<void> {
  const D = 6; // first data row in dep_template (rows 1-5 are header)

  for (const dept of Object.keys(DEPT_COLORS)) {
    const persons = allPersons
      .filter(p => p.department === dept)
      .sort((a, b) => normaliseName(a.fullname).localeCompare(normaliseName(b.fullname), 'th'));

    if (persons.length === 0) continue;
    // Brief pause between dept sheets to avoid write-quota exhaustion
    await sleep(1000);
    log(`  [SK03] Dept sheet: "${dept}" (${persons.length})`);

    // Copy dep_template
    const copyRes = await withRetry(() => sheets.spreadsheets.sheets.copyTo({
      spreadsheetId: CONFIG.sk03TemplateId, sheetId: depTmplSheetId,
      requestBody: { destinationSpreadsheetId: ssId },
    }));
    const sheetId = copyRes.data.sheetId!;

    // Rename + tab colour
    const rgb = DEPT_COLORS[dept] ? hexToRgb(DEPT_COLORS[dept]) : null;
    await withRetry(() => sheets.spreadsheets.batchUpdate({
      spreadsheetId: ssId,
      requestBody: { requests: [{
        updateSheetProperties: {
          properties: { sheetId, title: dept, ...(rgb ? { tabColorStyle: { rgbColor: rgb } } : {}) },
          fields: rgb ? 'title,tabColorStyle' : 'title',
        },
      }]},
    }));

    // Header: A2 = month/year, A3 = dept name (mirrors GAS)
    await withRetry(() => sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: ssId,
      requestBody: {
        valueInputOption: 'RAW',
        data: [
          { range: `'${dept}'!A2`, values: [[`ประจำเดือน  ${THAI_MONTHS[month]}  พ.ศ.  ${beYear}`]] },
          { range: `'${dept}'!A3`, values: [[`หน่วยงาน  ${dept} กลุ่มภารกิจ ด้าน${dept === 'เวชกรรมสังคม' ? 'ปฐมภูมิ' : 'ตติยภูมิ'}`]] },
        ],
      },
    }));

    // Data rows: [count, "prefix firstname  lastname", "position+rank", type, mgmt_amount, 0, 0, " ", remark]
    // Note: double space before lastname — this is the key for rowNumMap lookup
    // F and G are later overwritten by formulas; E stays as the direct management_stipends amount.
    const rows: (string | number)[][] = persons.map((p, idx) => {
      const mgmt = getMgmt(p);
      return [
        idx + 1,
        `${p.prefix} ${p.firstname}  ${p.lastname}`,  // double space before lastname
        `${p.position}${p.rank ? ' ' + p.rank : ''}`,    // position + rank (supabase 'rank')
        p.type || '',                                   // D: type (supabase 'type')
        mgmt?.amount ?? 0,   // E: management amount (or 0)
        0, 0, ' ',
        mgmt?.remark ?? ' ', // I: remark
      ];
    });
    await withRetry(() => sheets.spreadsheets.values.append({
      spreadsheetId: ssId,
      range: `'${dept}'!A${D}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: rows },
    }));

    const lastRow      = D + persons.length - 1;
    const isInternDept = dept === 'INTERN';
    const formulaData: sheets_v4.Schema$ValueRange[] = [];

    // Set E, F, G formulas referencing staff/intern sheet via row_num
    // Non-INTERN: E = staff!M, F = staff!N, G = E+F
    // INTERN:     F = intern!N, G = E+F (E left as 0)
    for (let i = 0; i < persons.length; i++) {
      const p       = persons[i];
      const nameKey = `${p.prefix} ${p.firstname}  ${p.lastname}`;
      const rowNum  = rowNumMap[nameKey];
      const r       = D + i;

      if (rowNum == null) { log(`  [SK03] ⚠ row_num missing for "${nameKey}"`, 'warn'); continue; }

      if (isInternDept) {
        formulaData.push({ range: `'${dept}'!F${r}`, values: [[`='${internSheetName}'!N${rowNum}`]] });
        formulaData.push({ range: `'${dept}'!G${r}`, values: [[`=E${r}+F${r}`]] });
      } else {
        // E: direct amount from management_stipends (written in rows above); no formula override
        formulaData.push({ range: `'${dept}'!F${r}`, values: [[`='${staffSheetName}'!N${rowNum}`]] });
        formulaData.push({ range: `'${dept}'!G${r}`, values: [[`=E${r}+F${r}`]] });
      }
    }
    if (formulaData.length > 0) {
      await withRetry(() => sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: ssId,
        requestBody: { valueInputOption: 'USER_ENTERED', data: formulaData },
      }));
    }

    // Borders + number format (mirrors GAS dep: A6:I with inner, E6:G number format)
    const R_S = D - 1; // 0-based data start
    const R_E = lastRow - 1;
    await withRetry(() => sheets.spreadsheets.batchUpdate({
      spreadsheetId: ssId,
      requestBody: { requests: [
        bordersReq(sheetId, R_S, 0, R_E, 8, true),
        { repeatCell: {
            range: gridRange(sheetId, R_S, 4, R_E, 6),
            cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '###,##0.00' } } },
            fields: 'userEnteredFormat.numberFormat',
        }},
      ]},
    }));

    // 5 blank rows then signatures at lastRow+3 (two sections) and lastRow+5 (one)
    const blankRows: string[][] = Array.from({ length: 5 }, () => Array.from({ length: 10 }, () => ' '));
    await withRetry(() => sheets.spreadsheets.values.append({
      spreadsheetId: ssId,
      range: `'${dept}'!A${lastRow + 1}`,
      valueInputOption: 'RAW',
      requestBody: { values: blankRows },
    }));

    const sig1 = lastRow + 3;
    const sig2 = lastRow + 5;
    await withRetry(() => sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: ssId,
      requestBody: {
        valueInputOption: 'RAW',
        data: [
          { range: `'${dept}'!A${sig1}`, values: [['................................................................................................................หัวหน้างาน/กลุ่มงาน/ฝ่าย']] },
          { range: `'${dept}'!E${sig1}`, values: [['................................................................................................................หัวหน้ากลุ่มภารกิจ']] },
          { range: `'${dept}'!A${sig2}`, values: [['................................................................................................................ประธานคณะกรรมการตรวจสอบค่าคะแนน']] },
        ],
      },
    }));
    await withRetry(() => sheets.spreadsheets.batchUpdate({
      spreadsheetId: ssId,
      requestBody: { requests: [
        { mergeCells: { range: gridRange(sheetId, sig1-1, 0, sig1-1, 3), mergeType: 'MERGE_ALL' } }, // A:D
        { mergeCells: { range: gridRange(sheetId, sig1-1, 4, sig1-1, 8), mergeType: 'MERGE_ALL' } }, // E:I
        { mergeCells: { range: gridRange(sheetId, sig2-1, 0, sig2-1, 8), mergeType: 'MERGE_ALL' } }, // A:I
        { repeatCell: { range: gridRange(sheetId, sig1-1, 0, sig1-1, 8), cell: { userEnteredFormat: { horizontalAlignment: 'CENTER', textFormat: { bold: true } } }, fields: 'userEnteredFormat(horizontalAlignment,textFormat)' } },
        { repeatCell: { range: gridRange(sheetId, sig2-1, 0, sig2-1, 8), cell: { userEnteredFormat: { horizontalAlignment: 'CENTER', textFormat: { bold: true } } }, fields: 'userEnteredFormat(horizontalAlignment,textFormat)' } },
        { repeatCell: { range: gridRange(sheetId, sig1-1, 0, sig2-1, 8), cell: { userEnteredFormat: { textFormat: { fontFamily: 'TH SarabunPSK', fontSize: 16 } } }, fields: 'userEnteredFormat.textFormat.fontFamily,userEnteredFormat.textFormat.fontSize' } },
      ]},
    }));
  }

  // Delete "ชีต1" if still present (created with the spreadsheet, normally deleted in staff step)
  const meta   = await withRetry(() => sheets.spreadsheets.get({ spreadsheetId: ssId, fields: 'sheets.properties' }));
  const sheet1 = meta.data.sheets!.find(s => s.properties!.title === 'ชีต1');
  if (sheet1) {
    await withRetry(() => sheets.spreadsheets.batchUpdate({ spreadsheetId: ssId, requestBody: { requests: [{ deleteSheet: { sheetId: sheet1.properties!.sheetId! } }] } }));
    log('  [SK03] Deleted default "ชีต1" sheet');
  }
}

// ─── Master orchestrator ──────────────────────────────────────────

/**
 * Create the full SK03 spreadsheet for a given month.
 * Sequence mirrors the original three GAS scripts:
 *   1. staff GAS  → creates spreadsheet + staff sheet + patches Supabase row_num
 *   2. intern GAS → adds intern sheet + patches Supabase row_num
 *   3. dep GAS    → adds one dept sheet per department
 */
async function createSK03(
  drive: drive_v3.Drive,
  sheets: sheets_v4.Sheets,
  supabasePersons: SupabasePerson[],
  monthKey: string,
  supabase: SupabaseClient,
  input: BudgetInput | undefined
): Promise<string> {
  const [beYearStr, monthStr] = monthKey.split('_');
  const beYear = parseInt(beYearStr);
  const month  = parseInt(monthStr);
  // Sheet names derived directly from monthKey — same source as the merge step
  const sheetBase       = monthKeyToSheetBase(monthKey);  // e.g. "ธ.ค. 68"
  const staffSheetName  = `${sheetBase} - staff`;
  const internSheetName = `${sheetBase} - intern`;
  const S = 8; // first data row in overall sheets

  // ── Sort people (DEPT_COLORS order → name within dept) ───────────
  const staffArray: SupabasePerson[]  = [];
  const internArray: SupabasePerson[] = [];
  for (const dept of Object.keys(DEPT_COLORS)) {
    const sorted = supabasePersons
      .filter(p => p.department === dept)
      .sort((a, b) => normaliseName(a.fullname).localeCompare(normaliseName(b.fullname), 'th'));
    if (dept === 'INTERN') internArray.push(...sorted);
    else staffArray.push(...sorted);
  }

  // ── Find old copies, create new spreadsheet, then delete old ones ──
  const existing = await driveListAll(drive, {
    q: `'${CONFIG.sk03FolderId}' in parents and name='sk03 - ${monthKey}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
    fields: 'nextPageToken, files(id)', pageSize: 10,
  });

  log(`  [SK03] Creating "sk03 - ${monthKey}"…`);
  const ssId = (await withRetry(() => drive.files.create({
    requestBody: { name: `sk03 - ${monthKey}`, mimeType: 'application/vnd.google-apps.spreadsheet', parents: [CONFIG.sk03FolderId] },
    fields: 'id',
  }))).data.id!;
  log(`  [SK03] id: ${ssId}`);

  for (const old of existing) {
    await withRetry(() => drive.files.delete({ fileId: old.id! }));
    log(`  [SK03] Deleted old file: ${old.id}`);
  }

  // ── Fetch template sheet IDs ──────────────────────────────────────
  const tmplSheets = (await withRetry(() => sheets.spreadsheets.get({ spreadsheetId: CONFIG.sk03TemplateId, fields: 'sheets.properties' }))).data.sheets!;
  const findTmpl   = (name: string): number => {
    const s = tmplSheets.find(sh => sh.properties!.title === name);
    if (!s) throw new Error(`Template sheet "${name}" not found`);
    return s.properties!.sheetId!;
  };
  const overallTmplId = findTmpl('overall_template');
  const depTmplId     = findTmpl('dep_template');

  // Get all existing sheets (to delete after copying the first new sheet)
  const ssSheets   = (await withRetry(() => sheets.spreadsheets.get({ spreadsheetId: ssId, fields: 'sheets.properties' }))).data.sheets!;
  const oldSheetIds = ssSheets.map(sh => sh.properties!.sheetId!);

  // ══════════════════════════════════════════════════════════════════
  //  1. Staff sheet
  // ══════════════════════════════════════════════════════════════════
  log(`  [SK03] Staff sheet (${staffArray.length} persons)…`);
  const staffSheetId = (await withRetry(() => sheets.spreadsheets.sheets.copyTo({
    spreadsheetId: CONFIG.sk03TemplateId, sheetId: overallTmplId,
    requestBody: { destinationSpreadsheetId: ssId },
  }))).data.sheetId!;

  // Delete all pre-existing sheets first (avoids name conflict on rename),
  // then rename the newly copied sheet to the target name.
  if (oldSheetIds.length > 0) {
    await withRetry(() => sheets.spreadsheets.batchUpdate({ spreadsheetId: ssId, requestBody: { requests:
      oldSheetIds.map(id => ({ deleteSheet: { sheetId: id } })),
    }}));
  }
  await withRetry(() => sheets.spreadsheets.batchUpdate({ spreadsheetId: ssId, requestBody: { requests: [
    { updateSheetProperties: { properties: { sheetId: staffSheetId, title: staffSheetName }, fields: 'title' } },
  ]}}));

  // A3 header
  await withRetry(() => sheets.spreadsheets.values.update({ spreadsheetId: ssId, range: `'${staffSheetName}'!A3`, valueInputOption: 'RAW', requestBody: { values: [[`ประจำเดือน  ${THAI_MONTHS[month]}  พ.ศ.  ${beYear}`]] } }));

  // Data rows
  // Headers, panel and department table first (they also clear the
  // template's old Q.. columns), then the data rows that read them.
  const staffLastRow = S + staffArray.length - 1;
  await writeOverallMeta(sheets, ssId, staffSheetName, staffSheetId, staffLastRow, false, internSheetName, input);
  const staffRows = buildOverallRows(staffArray, S, false, staffSheetName);
  if (staffRows.length > 0) {
    await withRetry(() => sheets.spreadsheets.values.update({ spreadsheetId: ssId, range: `'${staffSheetName}'!A${S}:T${S + staffRows.length - 1}`, valueInputOption: 'USER_ENTERED', requestBody: { values: staffRows } }));
  }
  await formatOverallSheet(sheets, ssId, staffSheetId, staffArray, staffLastRow, false, internSheetName);

  // Totals row: M, N, O = SUM immediately below last person, above signature.
  // Use values.append so it auto-extends the grid — no grid limit errors.
  const RED = { red: 0.933, green: 0.294, blue: 0.169 }; // #EE4B2B
  const totalsRow: (string | number)[] = Array.from({ length: 26 }, () => '');  // 26 blank cells (cols A-Z)
  totalsRow[12] = `=SUM(M${S}:M${staffLastRow})`;  // col M (idx 12)
  totalsRow[13] = `=SUM(N${S}:N${staffLastRow})`;  // col N (idx 13)
  totalsRow[14] = `=SUM(O${S}:O${staffLastRow})`;  // col O (idx 14)

  const appendRes = await withRetry(() => sheets.spreadsheets.values.append({
    spreadsheetId: ssId,
    range: `'${staffSheetName}'!A${staffLastRow + 1}`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [totalsRow] },
  }));
  // Find the actual row number appended (1-based)
  const staffTotalRowRange = appendRes.data.updates?.updatedRange ?? '';
  const staffTotalRowMatch = staffTotalRowRange.match(/:?[A-Z](\d+)$/);
  const staffTotalRow = staffTotalRowMatch ? parseInt(staffTotalRowMatch[1]) : staffLastRow + 1;

  // Paint M:O of the totals row red; clear M:O below it (template residual colours)
  await withRetry(() => sheets.spreadsheets.batchUpdate({
    spreadsheetId: ssId,
    requestBody: { requests: [
      {
        repeatCell: {
          range: gridRange(staffSheetId, staffTotalRow - 1, 12, staffTotalRow - 1, 14),
          cell: { userEnteredFormat: { backgroundColor: RED } },
          fields: 'userEnteredFormat.backgroundColor',
        },
      },
      {
        repeatCell: {
          range: gridRange(staffSheetId, staffTotalRow, 12, staffTotalRow + 19, 14),
          cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 1, blue: 1 } } },
          fields: 'userEnteredFormat.backgroundColor',
        },
      },
    ]},
  }));

  await writeOverallSignature(sheets, ssId, staffSheetName, staffSheetId, staffTotalRow);

  // Patch Supabase row_num for staff
  log(`  [SK03] Patching row_num for ${staffArray.length} staff…`);
  for (let i = 0; i < staffArray.length; i++) {
    if (staffArray[i].index == null) continue;
    const { error } = await supabase.from(monthKey).update({ row_num: S + i }).eq(SB.index, staffArray[i].index);
    if (error) log(`  [SK03] ⚠ row_num patch failed for index ${staffArray[i].index}: ${error.message}`, 'warn');
  }

  // ══════════════════════════════════════════════════════════════════
  //  2. Intern sheet
  // ══════════════════════════════════════════════════════════════════
  log(`  [SK03] Intern sheet (${internArray.length} persons)…`);
  const internSheetId = (await withRetry(() => sheets.spreadsheets.sheets.copyTo({
    spreadsheetId: CONFIG.sk03TemplateId, sheetId: overallTmplId,
    requestBody: { destinationSpreadsheetId: ssId },
  }))).data.sheetId!;

  await withRetry(() => sheets.spreadsheets.batchUpdate({ spreadsheetId: ssId, requestBody: { requests: [
    { updateSheetProperties: { properties: { sheetId: internSheetId, title: internSheetName, index: 1 }, fields: 'title,index' } },
  ]}}));

  await withRetry(() => sheets.spreadsheets.values.update({ spreadsheetId: ssId, range: `'${internSheetName}'!A3`, valueInputOption: 'RAW', requestBody: { values: [[`ประจำเดือน  ${THAI_MONTHS[month]}  พ.ศ.  ${beYear}`]] } }));

  const internLastRow = S + internArray.length - 1;
  await writeOverallMeta(sheets, ssId, internSheetName, internSheetId, internLastRow, true, internSheetName, input);
  const internRows = buildOverallRows(internArray, S, true, staffSheetName);
  if (internRows.length > 0) {
    await withRetry(() => sheets.spreadsheets.values.update({ spreadsheetId: ssId, range: `'${internSheetName}'!A${S}:Q${S + internRows.length - 1}`, valueInputOption: 'USER_ENTERED', requestBody: { values: internRows } }));
  }
  await formatOverallSheet(sheets, ssId, internSheetId, internArray, internLastRow, true, internSheetName);

  // Staff W10 (intern paid) reads the intern sheet, which did not exist yet
  // when the staff panel was written — write it again so it cannot stay #REF!.
  const w10 = staffPanel(internSheetName, S, staffLastRow, 0, '').panel.find(p => p.row === 10)!;
  await withRetry(() => sheets.spreadsheets.values.update({ spreadsheetId: ssId, range: `'${staffSheetName}'!${STAFF_PANEL.value}10`, valueInputOption: 'USER_ENTERED', requestBody: { values: [[w10.value!]] } }));

  // Intern totals row: N and O only (no M — management fee not applicable for interns)
  const internTotalsRow: (string | number)[] = Array.from({ length: 26 }, () => '');
  internTotalsRow[13] = `=SUM(N${S}:N${internLastRow})`;  // col N (idx 13)
  internTotalsRow[14] = `=SUM(O${S}:O${internLastRow})`;  // col O (idx 14)

  const internAppendRes = await withRetry(() => sheets.spreadsheets.values.append({
    spreadsheetId: ssId,
    range: `'${internSheetName}'!A${internLastRow + 1}`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [internTotalsRow] },
  }));
  const internTotalRowRange = internAppendRes.data.updates?.updatedRange ?? '';
  const internTotalRowMatch = internTotalRowRange.match(/:?[A-Z](\d+)$/);
  const internTotalRow = internTotalRowMatch ? parseInt(internTotalRowMatch[1]) : internLastRow + 1;

  await withRetry(() => sheets.spreadsheets.batchUpdate({
    spreadsheetId: ssId,
    requestBody: { requests: [
      {
        repeatCell: {
          range: gridRange(internSheetId, internTotalRow - 1, 13, internTotalRow - 1, 14),
          cell: { userEnteredFormat: { backgroundColor: RED } },
          fields: 'userEnteredFormat.backgroundColor',
        },
      },
      {
        repeatCell: {
          range: gridRange(internSheetId, internTotalRow, 13, internTotalRow + 19, 14),
          cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 1, blue: 1 } } },
          fields: 'userEnteredFormat.backgroundColor',
        },
      },
    ]},
  }));

  await writeOverallSignature(sheets, ssId, internSheetName, internSheetId, internTotalRow);

  // Patch Supabase row_num for intern
  log(`  [SK03] Patching row_num for ${internArray.length} interns…`);
  for (let i = 0; i < internArray.length; i++) {
    if (internArray[i].index == null) continue;
    const { error } = await supabase.from(monthKey).update({ row_num: S + i }).eq(SB.index, internArray[i].index);
    if (error) log(`  [SK03] ⚠ row_num patch failed for index ${internArray[i].index}: ${error.message}`, 'warn');
  }

  // ══════════════════════════════════════════════════════════════════
  //  3. Department sheets
  // ══════════════════════════════════════════════════════════════════
  // Build row_num lookup: "prefix firstname  lastname" → row in staff/intern sheet
  const rowNumMap: Record<string, number> = {};
  const addToRowNumMap = (p: SupabasePerson, row: number): void => {
    const key = `${p.prefix} ${p.firstname}  ${p.lastname}`;
    if (key in rowNumMap) log(`  [SK03] ⚠ rowNumMap duplicate key: "${key}" — overwriting row ${rowNumMap[key]} with ${row}`, 'warn');
    rowNumMap[key] = row;
  };
  staffArray.forEach( (p, i) => addToRowNumMap(p, S + i));
  internArray.forEach((p, i) => addToRowNumMap(p, S + i));

  await buildDeptSheets(sheets, ssId, depTmplId, supabasePersons, beYear, month, staffSheetName, internSheetName, rowNumMap);

  log(`  [SK03] ✓ Done → https://docs.google.com/spreadsheets/d/${ssId}`);
  return ssId;
}

// ═══════════════════════════════════════════════════════════════════
//  DATAFLOW DIAGRAM
// ═══════════════════════════════════════════════════════════════════
function showDataflow(): void {
  console.log('');
  console.log('  ┌──────────────────────┐     ┌──────────────────────┐');
  console.log('  │     Google Drive      │     │       Supabase        │');
  console.log('  │  (monthly .xlsx files)│     │  (persons + scores)   │');
  console.log('  └──────────┬───────────┘     └───────────┬───────────┘');
  console.log('             │ Step 2: list files           │ Step 3: fetch persons');
  console.log('             │                             │');
  console.log('             └──────────────┬──────────────┘');
  console.log('                            │');
  console.log('               Step 4: validate lists match');
  console.log('                            │');
  console.log('                            ▼');
  console.log('          Step 4.5: fill missing scores          ←── Google Drive (Excel)');
  console.log('               (score=null → extract from        ──► Supabase (score update)');
  console.log('                physician Excel, save to SB)');
  console.log('                            │');
  console.log('                            ▼');
  console.log('               Step 5: merge → one workbook');
  console.log('                    (1 sheet per person,');
  console.log('                     sorted by department)');
  console.log('                            │');
  console.log('                            ▼');
  console.log('               Step 6: create SK03 spreadsheet');
  console.log('                    (staff / intern / dept sheets)');
  console.log('                            │');
  console.log('             ┌──────────────┴──────────────┐');
  console.log('             ▼                             ▼');
  console.log('  ┌──────────────────────┐     ┌──────────────────────┐');
  console.log('  │     Google Drive      │     │       Supabase        │');
  console.log('  │  (merged workbook)    │     │  (row_num updated)    │');
  console.log('  └──────────────────────┘     └──────────────────────┘');
  console.log('');
}

// ═══════════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  const missing = ([
    ['GOOGLE_CLIENT_ID',         CONFIG.google.clientId],
    ['GOOGLE_CLIENT_SECRET',     CONFIG.google.clientSecret],
    ['GOOGLE_REFRESH_TOKEN',     CONFIG.google.refreshToken],
    ['SUPABASE_URL',             CONFIG.supabase.url],
    ['SUPABASE_KEY',             CONFIG.supabase.key],
    ['GOOGLE_ROOT_FOLDER_ID',    CONFIG.rootFolderId],
    ['GOOGLE_MERGE_FOLDER_ID',   CONFIG.outputFolderId],
    ['GOOGLE_SK03_FOLDER_ID',    CONFIG.sk03FolderId],
    ['GOOGLE_SK03_TEMPLATE_ID',  CONFIG.sk03TemplateId],
  ] as Array<[string, string]>).filter(([, v]) => !v).map(([k]) => k);

  if (missing.length > 0) {
    console.error('\n❌  Missing variables in .env:');
    missing.forEach(k => console.error(`     • ${k}`));
    process.exit(1);
  }

  const drive    = createDriveClient();
  const sheets   = createSheetsClient();
  const supabase = createClient(CONFIG.supabase.url, CONFIG.supabase.key);
  const months   = getTargetMonths();

  // Management stipend data is the same across every month in this run —
  // fetch it once here rather than per month.
  await loadManagementStipends(supabase);

  // Pre-flight: verify SK03 template has required sheets before processing any month
  log('[Pre-flight] Verifying SK03 template sheets…');
  const tmplCheck = await withRetry(() => sheets.spreadsheets.get({ spreadsheetId: CONFIG.sk03TemplateId, fields: 'sheets.properties' }));
  const tmplTitles = tmplCheck.data.sheets!.map(s => s.properties!.title);
  for (const required of ['overall_template', 'dep_template']) {
    if (!tmplTitles.includes(required)) {
      console.error(`\n❌  SK03 template is missing sheet: "${required}"`);
      process.exit(1);
    }
  }
  log('[Pre-flight] ✓ Template OK');

  // Pre-flight: every staff department needs a capacity multiplier (new formula)
  for (const dept of Object.keys(DEPT_COLORS)) {
    if (dept !== 'INTERN') checkDept(dept); // throws on a department missing from DEPT_CAPACITY
  }

  // Monthly budget and perP4P (throws on a malformed file, before any month is touched)
  const budgetInputs = loadBudgetInputs();
  log(`[Pre-flight] ✓ ${BUDGET_FILE}: ${Object.keys(budgetInputs).sort().join(', ') || '(no months)'}`);

  console.log('══════════════════════════════════════════════════════');
  console.log(' P4P Excel Merge + SK03 Pipeline');
  console.log('══════════════════════════════════════════════════════');
  showDataflow();
  const TARGET_COMPLETE_MONTHS = 2;
  console.log('Candidate window:', months.map(m => m.key).join(', '), `(targets the latest ${TARGET_COMPLETE_MONTHS} complete months)`);
  console.log('');

  interface Results {
    processed: number;
    skipped: number;
    failed: { key: string; error: string }[];
  }
  const results: Results = { processed: 0, skipped: 0, failed: [] };

  // ── Phase A — discovery ──────────────────────────────────────────
  // Walk newest → oldest. Steps 2-4 already signal "not ready yet" by
  // returning null/false for the expected cases (no Drive folder yet, no
  // Supabase table yet, list mismatch) — continue past those to keep
  // looking at older months. A genuine thrown error is NOT caught here:
  // it propagates and fails the whole job, same as an unexpected error
  // anywhere else in this script. Stop once TARGET_COMPLETE_MONTHS complete
  // months are found, or the window is exhausted — this is a fixed top-N
  // scan, not unbounded backlog-hunting past older months.
  console.log(`┌─ Discovery ${'─'.repeat(40)}`);
  interface CompleteMonth {
    key: string;
    monthInfo: MonthInfo;
    driveData: DriveMonthData;
    sbData: SupabasePerson[];
  }
  const completeMonths: CompleteMonth[] = [];
  for (const monthInfo of months) {
    if (completeMonths.length >= TARGET_COMPLETE_MONTHS) break;
    const { key } = monthInfo;

    log(`  [${key}] Step 2 — Google Drive…`);
    const driveData = await getDriveMonthData(drive, monthInfo);
    if (!driveData) { log(`  [${key}] → no Drive data — skipping`, 'warn'); continue; }
    log(`  [${key}] → ${driveData.names.length} files`);

    log(`  [${key}] Step 3 — Supabase…`);
    const sbData = await getSupabaseMonthData(supabase, key);
    if (!sbData) { log(`  [${key}] → no Supabase data — skipping`, 'warn'); continue; }
    log(`  [${key}] → ${sbData.length} persons`);

    log(`  [${key}] Step 4 — Comparing lists…`);
    if (!listsMatch(driveData.names, sbData)) {
      log(`  [${key}] → ✗ Lists do not match — skipping`, 'warn');
      continue;
    }
    log(`  [${key}] → ✓ Complete`);
    completeMonths.push({ key, monthInfo, driveData, sbData });
  }
  console.log(`└─ Found ${completeMonths.length} complete month(s): ${completeMonths.map(m => m.key).join(', ') || '(none)'}\n`);

  // ── Phase B — processing ─────────────────────────────────────────
  // Each discovered complete month is handled independently: an
  // already-run, null-scores, or merge-failure outcome — or an error — on
  // one must NOT block the other. Newest-first, so a timeout mid-run still
  // lands the more time-sensitive month.
  for (const { key, driveData, sbData } of completeMonths) {
    console.log(`\n┌─ ${key} ${'─'.repeat(46 - key.length)}`);
    try {
      // SK03 + merged files are regenerated and overwritten on EVERY run for
      // each complete month — there is deliberately no dedup guard here. The
      // Drive writes overwrite in place (uploadFileToDrive / createSK03 delete
      // old copies of the same name), so re-running is idempotent by output.

      // Step 4.5
      log('  [Step 4.5] Filling missing scores…');
      await fillMissingScores(drive, driveData.files, sbData, key, supabase);

      // Guard: all persons must have a non-null score before merge / SK03
      const nullAfterFill = sbData.filter(p => p.score === null && p.perf_score === 0);
      if (nullAfterFill.length > 0) {
        log(`  → ✗ ${nullAfterFill.length} person(s) still have no score after Step 4.5 — skipping merge & SK03`, 'warn');
        nullAfterFill.forEach(p => log(`    • ${p.fullname}`, 'warn'));
        results.skipped++; console.log('└─ skipped (null scores)\n'); continue;
      }
      log('  → ✓ All scores present');

      // Step 5
      log('  [Step 5] Merging…');
      const uploaded = await mergeAndUpload(drive, driveData.files, sbData, key);
      if (!uploaded) { results.skipped++; console.log('└─ skipped\n'); continue; }

      // Step 6
      log('  [Step 6] Creating SK03 spreadsheet…');
      const input = budgetInputs[key];
      if (input) log(`  [Step 6] Budget and perP4P for ${key} from ${BUDGET_FILE}`);
      else {
        log(`  [Step 6] ⚠ ${key} is not in ${BUDGET_FILE} — งบทั้งหมด and perP4P stay 0, so pay shows 0`, 'warn');
        console.log(`::warning title=SK03 ${key}::no budget/perP4P in ${BUDGET_FILE}; SK03 pay shows 0`);
      }
      await createSK03(drive, sheets, sbData, key, supabase, input);

      results.processed++;
      console.log('└─ ✓ complete\n');
    } catch (err: any) {
      console.error(`  [ERROR] ${err.stack ?? err.message}`);
      results.failed.push({ key, error: err.message });
      console.log('└─ failed\n');
      // NOT a break/return — the other discovered complete month still runs.
    }
  }

  console.log('══════════════════════════════════════════════════════');
  console.log(` ✓ Processed: ${results.processed}`);
  console.log(` ⊘ Skipped  : ${results.skipped}`);
  console.log(` ✗ Failed   : ${results.failed.length}`);
  results.failed.forEach(f => console.log(`     ${f.key}: ${f.error}`));
  console.log('');
}

main().catch((err: any) => { console.error('\nFatal:', err.stack ?? err); process.exit(1); });
