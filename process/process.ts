#!/usr/bin/env node
/**
 * P4P Excel Merge + SK03 Pipeline
 * Step 1  — 6-month candidate window in BE format
 * Step 2  — Google Drive: find month folder, list Excel files
 * Step 3  — Supabase: fetch person list + metadata
 * Step 4  — Compare Drive vs Supabase lists
 * Step 5  — Merge individual Excel files → one workbook per person sheet
 * Step 6  — Create SK03 Google Spreadsheet via Sheets API (mirrors GAS doPost)
 *           Pay uses the new formula (./sk03-formula.ts): every staff member
 *           gets 10,000 plus a share of the rest by department and score
 *           (sheet งบรายสาขา); interns are paid from what the staff leave. The
 *           total budget (staff Y9) and per P4P (intern W9) come from the
 *           Supabase table review_inputs, which the dashboard's overview
 *           page saves (a month card's งบ button: budget and N; per P4P =
 *           budget ÷ N). Pong, 2026-11-11: the one place for them, instead
 *           of process/FORMULA.md. A month with no row leaves the cells
 *           empty and pay 0. Once a saved budget is in the SK03, Pong gets
 *           a Telegram (./budget-notify.ts).
 * Step 7  — Keep a copy of both files and run the two automatic checks for
 *           the ตรวจสอบ tab (./review-build.ts).
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
 *
 * TARGET_MONTH (e.g. 2569_10) builds only that month: the ตรวจสอบ tab's
 * "สร้างไฟล์ใหม่" button and a changed budget start such a run through the
 * always-on relay, with REVIEW_REQUEST_ID so the tab can show its progress.
 * After the 2 months, the nightly run queues such a run for any older month
 * still under review on the auditee's side whose newest build is out of
 * date (review.queueOutdatedReviewMonths).
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
const {
  log, sleep, withRetry, stripExt, normaliseName,
  createAuth, createDriveClient, driveListAll, listFolders, listExcelFiles,
} = require('./lib') as typeof import('./lib');
const {
  DATA_START, BUDGET_SHEET, BUDGET_FIRST, BUDGET_LAST, BUDGET_TOTAL, DEPT_CAPACITY,
  STAFF_HEADERS, INTERN_HEADERS, deptCode, staffRowCells, internRowCells,
  internMeanCell, staffPanel, internPanel, budgetSheet,
} = require('./sk03-formula') as typeof import('./sk03-formula');
type CellWrite = import('./sk03-formula').CellWrite;
const review = require('./review-build') as typeof import('./review-build');
const { statedScoreFromWorkbook } = require('./fill-score') as typeof import('./fill-score');
type ReviewInput = import('./review-build').ReviewInput;
const { notifyBudgetBuilt } = require('./budget-notify') as typeof import('./budget-notify');
type DocInfo = import('./review-build').DocInfo;

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
  submitted_at: string | null;
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
  const target = (process.env.TARGET_MONTH ?? '').trim();
  if (target) {
    const m = /^(\d{4})_(\d{2})$/.exec(target);
    const month = m ? parseInt(m[2], 10) : 0;
    if (!m || month < 1 || month > 12) throw new Error(`TARGET_MONTH "${target}" is not like 2569_10`);
    return [{ key: target, beYear: parseInt(m[1], 10), month }];
  }
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
    log(`  [Drive] Overwriting "${fileName}"`);
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
    submitted_at: r.submitted_at ?? null,
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
    // Counts and roster row numbers only: this log is public, and a Drive
    // file is named after its physician.
    const driveOnly = normDrive.filter(n => !setSB.has(n)).length;
    if (driveOnly) log(`    ✗ ${driveOnly} Drive file(s) match no roster row`, 'warn');
    supabasePersons.forEach((p, i) => { if (!setDrive.has(normSB[i]!)) log(`    ✗ roster row #${p.index ?? '?'} has no Drive file`, 'warn'); });
    return false;
  }
  const s1 = [...normDrive].sort(), s2 = [...normSB].sort();
  let mismatches = 0;
  for (let i = 0; i < s1.length; i++) if (s1[i] !== s2[i]) mismatches++;
  if (mismatches) log(`  [Compare] ${mismatches} name(s) differ between Drive and the roster`, 'warn');
  return mismatches === 0;
}

// ═══════════════════════════════════════════════════════════════════
//  STEP 4.5 — Fill missing scores from Excel
// ═══════════════════════════════════════════════════════════════════
// The score is read by the submission pipeline's own extractor
// (lib/p4p-score.ts, via ./fill-score.ts), so a filled score is the one the
// doctor's email would have saved.

/**
 * Step 4.5 — for each person with score=null, read the score from their
 * Drive workbook with the pipeline's extractor and save it. Logged by roster
 * index, never by name or score: these logs are public.
 */
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
  log(`  [Score] ${nullScorePersons.length} person(s) with null score — reading their Excel…`);

  const driveMap: Record<string, DriveFile> = {};
  for (const file of driveFiles) {
    driveMap[normaliseName(stripExt(file.name!))] = file;
  }

  let updated = 0;
  const leftEmpty = (person: SupabasePerson, why: string): void =>
    log(`  [Score] ⚠ row #${person.index ?? '?'}: score left empty for an admin — ${why}`, 'warn');
  for (const person of nullScorePersons) {
    const file = driveMap[normaliseName(person.fullname)];
    if (!file) {
      leftEmpty(person, 'no Drive file');
      continue;
    }
    if (person.index === null) {
      leftEmpty(person, 'no roster index');
      continue;
    }
    try {
      const buffer = await downloadFile(drive, file.id!);
      const { score, method, write } = await statedScoreFromWorkbook(buffer);
      if (score === null) {
        leftEmpty(person, `no score found (${method})`);
        continue;
      }
      if (!write) {
        leftEmpty(person, `not saved (${method})`);
        continue;
      }

      const { error } = await supabase
        .from(monthKey)
        .update({ [SB.score]: score })
        .eq(SB.index, person.index);
      if (error) {
        log(`  [Score] ⚠ row #${person.index}: Supabase update failed: ${error.message}`, 'warn');
      } else {
        log(`  [Score] row #${person.index} → saved  (${method})`);
        person.score = score;  // keep sbData consistent for Step 5+
        updated++;
      }
    } catch (err: any) {
      log(`  [Score] ⚠ row #${person.index}: ${err.message}`, 'warn');
    }
  }
  log(`  [Score] ✓ ${updated}/${nullScorePersons.length} scores read and saved; ${nullScorePersons.length - updated} left empty`);
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
interface MergeResult {
  uploaded: drive_v3.Schema$File;
  buffer: Buffer;                 // the merged file exactly as uploaded
  docs: Map<string, DocInfo>;     // per doctor (normalised name): sheet name, stated total, snapshot
}

async function mergeAndUpload(
  drive: drive_v3.Drive,
  driveFiles: DriveFile[],
  supabasePersons: SupabasePerson[],
  monthKey: string,
  forReview = false
): Promise<MergeResult | null> {
  const deptMap: Record<string, string> = {};
  supabasePersons.forEach(p => { deptMap[normaliseName(p.fullname)] = p.department; });

  const filesWithName: NamedDriveFile[] = driveFiles.map(f => ({
    ...f, origName: stripExt(f.name!), normName: normaliseName(stripExt(f.name!)),
  }));
  filesWithName.sort((a, b) => sortByDeptThenName(a, b, deptMap));

  // Positions and departments only: this log is public, and each Drive file
  // is named after its physician.
  const perDept = new Map<string, number>();
  for (const f of filesWithName) {
    const d = deptMap[f.normName] ?? '?';
    perDept.set(d, (perDept.get(d) ?? 0) + 1);
  }
  log(`\n  [Merge] ${filesWithName.length} file(s) in department order: ` +
    [...perDept].map(([d, n]) => `${d} ${n}`).join(', '));

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
    const docs = new Map<string, DocInfo>();

    // Download each file into the temp directory
    for (const [i, file] of filesWithName.entries()) {
      log(`\n  [Merge] ↓ file ${i + 1}/${filesWithName.length}`);
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

      // For the ตรวจสอบ tab: the total the doctor wrote, from the saved values
      // (the merged copy loses them), and a snapshot of the sheet.
      if (forReview) {
        try {
          const a = await review.analyseDoctorFile(buffer);
          if (!docs.has(file.normName)) docs.set(file.normName, { sheetName, ...a });
        } catch (err: any) {
          log(`  [Merge] ⚠ could not read file ${i + 1} for the review tab: ${err.message}`, 'warn');
        }
      }
    }

    if (manifestEntries.length === 0) {
      log('  [Merge] ⚠ No files — nothing to upload', 'warn');
      return null;
    }

    // Write manifest for Python script
    const manifestPath = path.join(tmpDir, 'manifest.json');
    const outputPath   = path.join(tmpDir, 'merged.xlsx');
    fs.writeFileSync(manifestPath, JSON.stringify({ files: manifestEntries }, null, 2), 'utf8');

    // Invoke Python merge script. Its output names sheets by number, never
    // by their (physician) names, so it can go to this public log.
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
    // No link and no file id: this log is public and the folder may be
    // shared by link, so either one would open every physician's sheet.
    log(`  [Merge] ✓ uploaded`);
    return { uploaded, buffer: buf, docs };

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
 * Build the 22-column data rows (A..V) for an overall (staff/intern) sheet.
 * A..M and O..P mirror the appendRow loop in both GAS scripts. Pay (N) and
 * the helper columns Q..V use the new formula — see ./sk03-formula.ts.
 */
function buildOverallRows(persons: SupabasePerson[], S: number, isIntern: boolean): (string | number)[][] {
  const last = S + persons.length - 1;
  return persons.map((p, idx) => {
    const r = S + idx;
    const isDeptHead = DEPT_HEAD_SET.has(normaliseName(`${p.firstname} ${p.lastname}`));
    const pay = isIntern ? internRowCells(r) : staffRowCells(r, deptCode(p.department), S, last);
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
      `=K${r}-H${r}`,                                       // L: score above the 2,200 standard
      getMgmt(p)?.amount ?? p.boss_score ?? 0,              // M: mgmt amount or boss score (moved from I)
      pay.N,                                                 // N: P4P pay
      `=M${r}+N${r}`,                                       // O
      ' ',                                                   // P: remark
      ...pay.QtoV,                                           // Q..V: new-formula helpers
    ];
  });
}

/**
 * Write the column headers over Q..V (rows 5-7) and the side panel.
 * The template's old AVG±SD band headers and thresholds in Q5:Y7 are
 * cleared first. Staff panel sits in X/Y, intern panel in V/W (the same
 * cells as the trial workbook and its manual).
 */
async function writeOverallMeta(
  sheets: sheets_v4.Sheets,
  ssId: string,
  sheetName: string,
  lastRow: number,
  isIntern: boolean,
  internSheetName: string,
  input: ReviewInput | null,
  staffSheetName: string
): Promise<void> {
  const S = DATA_START;
  const sh = `'${sheetName}'!`;

  await withRetry(() => sheets.spreadsheets.values.batchClear({
    spreadsheetId: ssId,
    requestBody: { ranges: [`${sh}Q5:Y7`] },
  }));

  const headers = isIntern ? INTERN_HEADERS : STAFF_HEADERS;
  const cells: CellWrite[] = [
    ...headers.map(h => ({ range: `${h.col}5`, values: [[h.text]] })),
    ...(isIntern
      ? [internMeanCell(S, lastRow), ...internPanel(staffSheetName, S, lastRow, input?.per_p4p ?? '')]
      : staffPanel(internSheetName, S, lastRow, input?.budget ?? '')),
  ];

  await withRetry(() => sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: ssId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: cells.map(c => ({ range: `${sh}${c.range}`, values: c.values })),
    },
  }));
}

/** 0-based column index of a column letter (A → 0). */
function colIdx(letter: string): number {
  return letter.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
}

const NEW_FORMULA_FILL = { red: 1, green: 0.949, blue: 0.8 };       // #FFF2CC: new-formula cells
const NEW_HEADER_FILL  = { red: 0.988, green: 0.894, blue: 0.714 }; // #FCE4B6: new-formula headers
const FMT_BAHT  = '#,##0.00';
const FMT_RATIO = '0.0000';

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

/** Borders round a range plus a line between its rows (no lines between its columns). */
function rowLinesReq(sheetId: number, r1: number, c1: number, r2: number, c2: number): sheets_v4.Schema$Request {
  return { updateBorders: { range: gridRange(sheetId, r1, c1, r2, c2), top: SOLID, bottom: SOLID, left: SOLID, right: SOLID, innerHorizontal: SOLID } };
}

function alignReq(sheetId: number, r1: number, c1: number, r2: number, c2: number, h: 'LEFT' | 'CENTER' | 'RIGHT'): sheets_v4.Schema$Request {
  return { repeatCell: { range: gridRange(sheetId, r1, c1, r2, c2), cell: { userEnteredFormat: { horizontalAlignment: h } }, fields: 'userEnteredFormat.horizontalAlignment' } };
}

/** Clear background colour and borders (left behind by the template or a copied row). */
function clearFillBordersReq(sheetId: number, r1: number, c1: number, r2: number, c2: number): sheets_v4.Schema$Request {
  return { repeatCell: { range: gridRange(sheetId, r1, c1, r2, c2), cell: { userEnteredFormat: {} }, fields: 'userEnteredFormat(backgroundColor,borders)' } };
}

/** A new-formula cell block: yellow, each cell boxed. */
function yellowBoxReqs(sheetId: number, r1: number, c1: number, r2: number, c2: number): sheets_v4.Schema$Request[] {
  return [fillReq(sheetId, r1, c1, r2, c2, NEW_FORMULA_FILL), bordersReq(sheetId, r1, c1, r2, c2, true)];
}

const TOTALS_FILL = { red: 0.71, green: 0.898, blue: 0.91 }; // #B5E5E8: M:O / N:O totals

/**
 * Format the totals row appended under the last person (1-based `row`):
 * values.append copies the last person's colours into it, so clear the row,
 * then colour the totals from column `firstCol` (0-based) to O.
 */
function totalsRowReqs(sheetId: number, row: number, firstCol: number, bold: boolean): sheets_v4.Schema$Request[] {
  return [
    clearFillBordersReq(sheetId, row - 1, 0, row - 1, 25),
    { repeatCell: {
      range: gridRange(sheetId, row - 1, firstCol, row - 1, 14),
      cell: { userEnteredFormat: { backgroundColor: TOTALS_FILL, textFormat: { bold } } },
      fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.bold',
    }},
  ];
}

/**
 * Apply all formatting for an overall sheet (as in the reference workbook 2569_07_new_formula.xlsx):
 * - J column dept background per row
 * - Number formats (H:O = ###,##0.00, helper columns, panel)
 * - Data area borders, one line per row in A..D
 * - New-formula headers in Q..V rows 5-7, yellow new-formula cells, column widths
 * - Side panel grey headers + borders + merges, yellow boxed new-formula cells
 * - Template borders and colours below the last person cleared
 */
async function formatOverallSheet(
  sheets: sheets_v4.Sheets,
  ssId: string,
  sheetId: number,
  persons: SupabasePerson[],
  lastRow: number,
  isIntern: boolean
): Promise<void> {
  const S     = DATA_START;
  const R8    = S - 1;          // 0-based row 8
  const RLast = lastRow - 1;    // 0-based last data row
  const GRAY  = { red: 0.827, green: 0.827, blue: 0.827 }; // #D3D3D3
  const GRAY_CELL: sheets_v4.Schema$CellData   = { userEnteredFormat: { backgroundColor: GRAY, textFormat: { bold: true }, horizontalAlignment: 'CENTER' } };
  const GRAY_FIELDS = 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)';

  // Unmerge whatever the template merged in the Q..Y header block (rows 5-7)
  // before the new headers are merged. Each merge is unmerged over its full
  // range — unmerging part of a merge fails.
  const meta = await withRetry(() => sheets.spreadsheets.get({ spreadsheetId: ssId, fields: 'sheets(properties(sheetId,gridProperties),merges)' }));
  const sheetMeta = meta.data.sheets?.find(s => s.properties?.sheetId === sheetId);
  const merges = sheetMeta?.merges ?? [];
  const rowCount = sheetMeta?.properties?.gridProperties?.rowCount ?? lastRow;
  const lastCol  = Math.min(25, (sheetMeta?.properties?.gridProperties?.columnCount ?? 26) - 1);
  const fmtReqs: sheets_v4.Schema$Request[] = merges
    .filter(m => (m.startRowIndex ?? 0) <= 6 && (m.endRowIndex ?? 0) > 4 && (m.endColumnIndex ?? 0) > 16 && (m.startColumnIndex ?? 0) <= 24)
    .map(m => ({ unmergeCells: { range: m } }));

  // The template's old AVG±SD band headers: clear their colours and borders.
  fmtReqs.push(clearFillBordersReq(sheetId, 4, 16, 6, 24));

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

  // Below the last person: the template's bordered rows (it has 180) and any
  // residual colours are cleared, so the totals and signature rows stand alone.
  fmtReqs.push(clearFillBordersReq(sheetId, RLast + 1, 0, rowCount + 19, lastCol));

  // New-formula headers over Q..V, rows 5-7 (0-based 4-6)
  const headers = isIntern ? INTERN_HEADERS : STAFF_HEADERS;
  for (const h of headers) {
    const c = colIdx(h.col);
    const bottom = h.bottom - 1;
    fmtReqs.push({ mergeCells: { range: gridRange(sheetId, 4, c, bottom, c), mergeType: 'MERGE_ALL' } });
    fmtReqs.push({ repeatCell: {
      range: gridRange(sheetId, 4, c, bottom, c),
      cell: { userEnteredFormat: { backgroundColor: NEW_HEADER_FILL, textFormat: { bold: true, fontFamily: 'TH SarabunPSK', fontSize: 13 }, horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE', wrapStrategy: 'WRAP' } },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)',
    }});
    fmtReqs.push(bordersReq(sheetId, 4, c, 6, c));
  }
  // Header row 6 tall enough for the three-line headers
  fmtReqs.push({ updateDimensionProperties: { range: { sheetId, dimension: 'ROWS', startIndex: 5, endIndex: 6 }, properties: { pixelSize: 96 }, fields: 'pixelSize' } });

  // Helper columns on data rows: 14 pt, centred vertically, no wrapping
  const helperLast = colIdx(isIntern ? 'T' : 'V');
  fmtReqs.push({ repeatCell: {
    range: gridRange(sheetId, R8, colIdx('Q'), RLast, helperLast),
    cell: { userEnteredFormat: { textFormat: { fontSize: 14 }, verticalAlignment: 'MIDDLE', wrapStrategy: 'OVERFLOW_CELL' } },
    fields: 'userEnteredFormat.textFormat.fontSize,userEnteredFormat.verticalAlignment,userEnteredFormat.wrapStrategy',
  }});

  // Data rows: N:O and H:M as before, helper columns per their content
  fmtReqs.push(numFmtReq(sheetId, R8, 7, RLast, 14, '###,##0.00'));
  if (isIntern) {
    fmtReqs.push(numFmtReq(sheetId, R8, colIdx('Q'), RLast, colIdx('T'), FMT_RATIO));
    fmtReqs.push(numFmtReq(sheetId, 6, colIdx('S'), 6, colIdx('S'), FMT_BAHT));             // S7 mean
    fmtReqs.push(fillReq(sheetId, 6, colIdx('S'), 6, colIdx('S'), NEW_FORMULA_FILL));
    fmtReqs.push(bordersReq(sheetId, 6, colIdx('S'), 6, colIdx('S')));
    fmtReqs.push({ repeatCell: {
      range: gridRange(sheetId, 6, colIdx('S'), 6, colIdx('S')),
      cell: { userEnteredFormat: { textFormat: { bold: true, fontFamily: 'TH SarabunPSK', fontSize: 14 }, horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE' } },
      fields: 'userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.fontFamily,userEnteredFormat.textFormat.fontSize,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment',
    }});
    fmtReqs.push(fillReq(sheetId, R8, colIdx('Q'), RLast, colIdx('R'), NEW_FORMULA_FILL));
    fmtReqs.push(fillReq(sheetId, R8, colIdx('T'), RLast, colIdx('T'), NEW_FORMULA_FILL));
    fmtReqs.push(alignReq(sheetId, R8, colIdx('Q'), RLast, colIdx('T'), 'RIGHT'));
    fmtReqs.push(clearFillBordersReq(sheetId, R8, colIdx('S'), RLast, colIdx('S')));
    fmtReqs.push(clearFillBordersReq(sheetId, R8, colIdx('U'), RLast, colIdx('V')));
    fmtReqs.push(numFmtReq(sheetId, 7, colIdx('W'), 24, colIdx('W'), FMT_BAHT));             // panel values
    fmtReqs.push(numFmtReq(sheetId, 9, colIdx('W'), 9, colIdx('W'), '#,##0'));             // W10 count
    fmtReqs.push(numFmtReq(sheetId, 11, colIdx('W'), 11, colIdx('W'), FMT_RATIO));         // W12 sum point
  } else {
    fmtReqs.push(numFmtReq(sheetId, R8, colIdx('R'), RLast, colIdx('R'), FMT_BAHT));
    fmtReqs.push(numFmtReq(sheetId, R8, colIdx('S'), RLast, colIdx('U'), FMT_RATIO));
    fmtReqs.push(numFmtReq(sheetId, R8, colIdx('V'), RLast, colIdx('V'), FMT_BAHT));
    fmtReqs.push(fillReq(sheetId, R8, colIdx('Q'), RLast, colIdx('V'), NEW_FORMULA_FILL));
    fmtReqs.push(alignReq(sheetId, R8, colIdx('Q'), RLast, colIdx('Q'), 'CENTER'));
    fmtReqs.push(alignReq(sheetId, R8, colIdx('R'), RLast, colIdx('V'), 'RIGHT'));
    fmtReqs.push(numFmtReq(sheetId, 7, colIdx('Y'), 24, colIdx('Y'), FMT_BAHT));             // panel values
    fmtReqs.push(numFmtReq(sheetId, 10, colIdx('Y'), 10, colIdx('Y'), '#,##0'));           // Y11 count
  }
  fmtReqs.push(fillReq(sheetId, R8, colIdx('N'), RLast, colIdx('N'), NEW_FORMULA_FILL));    // pay

  // Data area borders: A one box per cell, B..D one line per row, E..P a full grid
  fmtReqs.push(bordersReq(sheetId, R8, 0,  RLast, 0, true));
  fmtReqs.push(rowLinesReq(sheetId, R8, 1, RLast, 3));
  fmtReqs.push(bordersReq(sheetId, R8, 4,  RLast, 15, true));
  fmtReqs.push(alignReq(sheetId, R8, 0, RLast, 0, 'CENTER'));                                // A sequence no.

  // Column widths (pixels). A..P come from the Google template, whose widths
  // are 1.375x the hospital SK03 form; set them to the form's widths (the
  // ones in Pong's 2569_07_new_formula.xlsx). Then the helper columns and
  // the panel.
  const formWidths: [string, number][] = [
    ['A', 33], ['B', 37], ['C', 122], ['D', 146], ['E', 92], ['F', 184], ['G', 195], ['H', 74],
    ['I', 100], ['J', isIntern ? 85 : 82], ['K', 100], ['L', 88], ['M', 106], ['N', 100], ['O', 100], ['P', 72],
  ];
  const widths: [string, number][] = isIntern
    ? [['Q', 87], ['R', 79], ['S', 95], ['T', 87], ['U', 32], ['V', 265], ['W', 166], ['X', 32], ['Y', 32]]
    : [['Q', 55], ['R', 95], ['S', 87], ['T', 79], ['U', 87], ['V', 95], ['W', 32], ['X', 265], ['Y', 166]];
  [...formWidths, ...widths].forEach(([col, px]) => fmtReqs.push(colWidthReq(sheetId, col, px)));

  // Side panel: label column / value column, grey header rows, bordered blocks
  const PL = colIdx(isIntern ? 'V' : 'X');
  const PV = PL + 1;
  // Staff: rows 8,12,16,22 → 0-based 7,11,15,21
  // Intern: rows 8,11,15   → 0-based 7,10,14
  const hdrRows = isIntern ? [7, 10, 14] : [7, 11, 15, 21];
  hdrRows.forEach(r => {
    fmtReqs.push({ repeatCell: { range: gridRange(sheetId, r, PL, r, PV), cell: GRAY_CELL, fields: GRAY_FIELDS } });
    fmtReqs.push(bordersReq(sheetId, r, PL, r, PV));
    fmtReqs.push({ mergeCells: { range: gridRange(sheetId, r, PL, r, PV), mergeType: 'MERGE_ALL' } });
  });

  if (isIntern) {
    fmtReqs.push(bordersReq(sheetId, 8,  PL, 9,  PV));  // V9:W10
    fmtReqs.push(bordersReq(sheetId, 11, PL, 13, PV));  // V12:W14
    fmtReqs.push(bordersReq(sheetId, 15, PL, 15, PV));  // V16:W16
    fmtReqs.push(...yellowBoxReqs(sheetId, 8, PV, 8, PV));     // W9
    fmtReqs.push(...yellowBoxReqs(sheetId, 9, PL, 9, PV));     // V10:W10
    fmtReqs.push(...yellowBoxReqs(sheetId, 11, PV, 13, PV));   // W12:W14
    fmtReqs.push(alignReq(sheetId, 7, PV, 15, PV, 'CENTER'));  // values
    [8, 9, 11, 12, 13, 15].forEach(r => fmtReqs.push(alignReq(sheetId, r, PL, r, PL, 'LEFT')));
    fmtReqs.push({ repeatCell: { range: gridRange(sheetId, 7, PL, 15, PL), cell: { userEnteredFormat: { wrapStrategy: 'OVERFLOW_CELL' } }, fields: 'userEnteredFormat.wrapStrategy' } });
  } else {
    fmtReqs.push(bordersReq(sheetId, 8,  PL, 10, PV));  // X9:Y11
    fmtReqs.push(bordersReq(sheetId, 12, PL, 14, PV));  // X13:Y15
    fmtReqs.push(bordersReq(sheetId, 16, PL, 19, PV));  // X17:Y20
    fmtReqs.push(bordersReq(sheetId, 22, PL, 22, PV));  // X23:Y23
    fmtReqs.push({ mergeCells: { range: gridRange(sheetId, 22, PL, 22, PV), mergeType: 'MERGE_ALL' } });
    fmtReqs.push({ repeatCell: { range: gridRange(sheetId, 22, PL, 22, PV), cell: { userEnteredFormat: { horizontalAlignment: 'CENTER', numberFormat: { type: 'NUMBER', pattern: FMT_BAHT } } }, fields: 'userEnteredFormat(horizontalAlignment,numberFormat)' } });
    fmtReqs.push(...yellowBoxReqs(sheetId, 8, PV, 9, PV));     // Y9:Y10
    fmtReqs.push(...yellowBoxReqs(sheetId, 10, PL, 10, PV));   // X11:Y11
    fmtReqs.push(...yellowBoxReqs(sheetId, 12, PL, 14, PV));   // X13:Y15
    fmtReqs.push(...yellowBoxReqs(sheetId, 18, PV, 18, PV));   // Y19
    fmtReqs.push(fillReq(sheetId, 24, PL, 24, PL, NEW_FORMULA_FILL)); // X25 note
    [10, 12, 13, 14].forEach(r => fmtReqs.push(alignReq(sheetId, r, PL, r, PL, 'LEFT')));  // X11, X13:X15
    fmtReqs.push({ repeatCell: {
      range: gridRange(sheetId, 24, PL, 25, PL),
      cell: { userEnteredFormat: { horizontalAlignment: 'LEFT', verticalAlignment: 'MIDDLE', textFormat: { fontSize: 14 } } },
      fields: 'userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment,userEnteredFormat.textFormat.fontSize',
    }});
  }

  await withRetry(() => sheets.spreadsheets.batchUpdate({ spreadsheetId: ssId, requestBody: { requests: fmtReqs } }));
}

/**
 * Write and format the งบรายสาขา sheet (per-department staff budget and
 * per P4P). The staff sheet's column V reads its column L.
 */
async function writeBudgetSheet(
  sheets: sheets_v4.Sheets,
  ssId: string,
  sheetId: number,
  staffSheetName: string,
  staffLastRow: number,
  monthLabel: string
): Promise<void> {
  const sh = `'${BUDGET_SHEET}'!`;
  const cells = budgetSheet(staffSheetName, DATA_START, staffLastRow, monthLabel);
  await withRetry(() => sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: ssId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: cells.map(c => ({ range: `${sh}${c.range}`, values: c.values })),
    },
  }));

  const F1 = BUDGET_FIRST - 1;   // 0-based first dept row
  const FL = BUDGET_LAST - 1;    // 0-based last dept row
  const T  = BUDGET_TOTAL - 1;   // 0-based total row
  const font = (size: number, bold = false): sheets_v4.Schema$CellFormat => ({ textFormat: { fontFamily: 'TH SarabunPSK', fontSize: size, bold } });
  const reqs: sheets_v4.Schema$Request[] = [
    { repeatCell: { range: gridRange(sheetId, 0, 0, T + 2, 13), cell: { userEnteredFormat: { ...font(14), verticalAlignment: 'MIDDLE' } }, fields: 'userEnteredFormat(textFormat,verticalAlignment)' } },
    { repeatCell: { range: gridRange(sheetId, 0, 0, 0, 13), cell: { userEnteredFormat: font(20, true) }, fields: 'userEnteredFormat.textFormat' } },
    { repeatCell: { range: gridRange(sheetId, 1, 0, 1, 13), cell: { userEnteredFormat: font(16) }, fields: 'userEnteredFormat.textFormat' } },
    // title rows 1-3 merged across A:N and centred
    ...[0, 1, 2].map(r => ({ mergeCells: { range: gridRange(sheetId, r, 0, r, 13), mergeType: 'MERGE_ALL' as const } })),
    alignReq(sheetId, 0, 0, 2, 13, 'CENTER'),
    // header rows 4-5: each column merged over both rows
    ...Array.from({ length: 14 }, (_, c) => ({ mergeCells: { range: gridRange(sheetId, 3, c, 4, c), mergeType: 'MERGE_ALL' as const } })),
    { repeatCell: {
      range: gridRange(sheetId, 3, 0, 4, 13),
      cell: { userEnteredFormat: { backgroundColor: NEW_HEADER_FILL, ...font(14, true), horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE', wrapStrategy: 'WRAP' } },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)',
    }},
    bordersReq(sheetId, 3, 0, T, 13, true),
    // formula cells yellow (D..N), department inputs (A..C) plain
    fillReq(sheetId, F1, 3, FL, 13, NEW_FORMULA_FILL),
    { repeatCell: { range: gridRange(sheetId, F1, 0, FL, 13), cell: { userEnteredFormat: { horizontalAlignment: 'CENTER' } }, fields: 'userEnteredFormat.horizontalAlignment' } },
    { repeatCell: { range: gridRange(sheetId, F1, 1, FL, 1), cell: { userEnteredFormat: { horizontalAlignment: 'LEFT' } }, fields: 'userEnteredFormat.horizontalAlignment' } },
    numFmtReq(sheetId, F1, 3, FL, 3, '0.0%'),               // D share short
    numFmtReq(sheetId, F1, 4, FL, 4, '0.00'),               // E department multiplier
    numFmtReq(sheetId, F1, 5, T, 5, '#,##0'),
    numFmtReq(sheetId, F1, 6, T, 6, FMT_BAHT),
    numFmtReq(sheetId, F1, 7, T, 7, '0.00'),
    numFmtReq(sheetId, F1, 8, T, 9, FMT_BAHT),
    numFmtReq(sheetId, F1, 10, T, 10, FMT_RATIO),
    numFmtReq(sheetId, F1, 11, T, 11, FMT_BAHT),
    numFmtReq(sheetId, F1, 12, T, 12, '#,##0'),
    numFmtReq(sheetId, F1, 13, T, 13, FMT_BAHT),
    numFmtReq(sheetId, T + 2, 9, T + 2, 9, FMT_BAHT),
    bordersReq(sheetId, T + 2, 9, T + 2, 9),                 // J26 check cell
    alignReq(sheetId, T + 2, 9, T + 2, 9, 'CENTER'),
    alignReq(sheetId, T + 2, 1, T + 2, 1, 'LEFT'),
    alignReq(sheetId, T + 2, 10, T + 2, 10, 'LEFT'),
    // total row
    { mergeCells: { range: gridRange(sheetId, T, 0, T, 4), mergeType: 'MERGE_ALL' } },
    { repeatCell: { range: gridRange(sheetId, T, 0, T, 13), cell: { userEnteredFormat: { backgroundColor: NEW_HEADER_FILL, ...font(14, true), horizontalAlignment: 'CENTER' } }, fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)' } },
    // Freeze the title and header rows only. Google Sheets refuses to freeze
    // columns through a merged cell (here A1:N1-A3:N3 and the A24:E24 total
    // label), and that refusal used to fail this whole batch: the sheet was
    // left unformatted and the department sheets were never built.
    { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 5, frozenColumnCount: 0, hideGridlines: true } }, fields: 'gridProperties(frozenRowCount,frozenColumnCount,hideGridlines)' } },
    ...([40, 270, 56, 111, 103, 71, 119, 127, 119, 119, 95, 103, 111, 95] as const).map((px, c) => ({
      updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS' as const, startIndex: c, endIndex: c + 1 }, properties: { pixelSize: px }, fields: 'pixelSize' },
    })),
    { updateDimensionProperties: { range: { sheetId, dimension: 'ROWS', startIndex: 3, endIndex: 5 }, properties: { pixelSize: 40 }, fields: 'pixelSize' } },
  ];
  await withRetry(() => sheets.spreadsheets.batchUpdate({ spreadsheetId: ssId, requestBody: { requests: reqs } }));
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
// Department sheet widths A..J in pixels: the hospital SK03 form's.
const DEPT_COL_PX = [46, 271, 221, 276, 116, 151, 130, 144, 156, 100];
// Rough width of a line of TH SarabunPSK 16 text: about 7 px per character
// that takes space (Thai vowel and tone marks above/below take none), plus
// cell padding.
function thaiTextPx(text: string): number {
  const spacing = [...text.trim()].filter(ch => !/[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/.test(ch)).length;
  return spacing === 0 ? 0 : Math.ceil(spacing * 7 + 14);
}

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

      if (rowNum == null) { log(`  [SK03] ⚠ row_num missing for roster row #${p.index ?? '?'}`, 'warn'); continue; }

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
    // Column widths: the dep_template's are 1.375x the hospital form; use the
    // form's (Pong's 2569_07_new_formula.xlsx). หมายเหตุ (I) grows to fit the
    // longest remark, as Pong widened it by hand for long remarks.
    const remarkPx = Math.max(DEPT_COL_PX[8], ...rows.map(r => thaiTextPx(String(r[8] ?? ''))));
    const deptWidths = DEPT_COL_PX.map((px, c) => colWidthReq(sheetId, String.fromCharCode(65 + c), c === 8 ? remarkPx : px));
    await withRetry(() => sheets.spreadsheets.batchUpdate({
      spreadsheetId: ssId,
      requestBody: { requests: [
        ...deptWidths,
        bordersReq(sheetId, R_S, 0, R_E, 8, true),
        alignReq(sheetId, R_S, 0, R_E, 0, 'CENTER'),             // A sequence no.
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
// Pong, 2026-11-11: every sheet of the SK03 uses one font, TH SarabunPSK.
// The templates and the code's own formatting leave a mix (Arial on the new
// งบรายสาขา sheet, "TH Sarabun PSK" with a space from the template, and
// cells whose textFormat was reset). One last pass sets the family on every
// cell of every sheet; the field mask touches only fontFamily, so size, bold,
// colour and values stay as they are. A failure only logs: the file is done.
const SK03_FONT = 'TH SarabunPSK';
async function normaliseSK03Fonts(sheets: sheets_v4.Sheets, ssId: string): Promise<void> {
  try {
    const meta = await withRetry(() => sheets.spreadsheets.get({ spreadsheetId: ssId, fields: 'sheets.properties(sheetId,title)' }));
    const requests: sheets_v4.Schema$Request[] = (meta.data.sheets ?? []).map(sh => ({
      repeatCell: {
        range: { sheetId: sh.properties!.sheetId! },
        cell: { userEnteredFormat: { textFormat: { fontFamily: SK03_FONT } } },
        fields: 'userEnteredFormat.textFormat.fontFamily',
      },
    }));
    if (requests.length === 0) return;
    await withRetry(() => sheets.spreadsheets.batchUpdate({ spreadsheetId: ssId, requestBody: { requests } }));
    log(`  [SK03] Font set to ${SK03_FONT} on ${requests.length} sheets`);
  } catch (err: any) {
    log(`  [SK03] ⚠ font pass failed (file kept): ${err.message}`, 'warn');
  }
}

async function createSK03(
  drive: drive_v3.Drive,
  sheets: sheets_v4.Sheets,
  supabasePersons: SupabasePerson[],
  monthKey: string,
  supabase: SupabaseClient,
  input: ReviewInput | null = null
): Promise<{ ssId: string; staffSheetName: string; internSheetName: string }> {
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
  log(`  [SK03] created`);

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

  // The intern and งบรายสาขา sheets are added now, empty, before any formula
  // is written: the staff sheet reads both (Y10/Y19 → intern W16, V/Y15 →
  // งบรายสาขา) and the budget sheet reads the staff sheet. Google Sheets keeps
  // a reference to a sheet that does not exist yet as #REF! even after the
  // sheet is added, so every sheet must exist first. Order: staff, intern, งบรายสาขา.
  const internSheetId = (await withRetry(() => sheets.spreadsheets.sheets.copyTo({
    spreadsheetId: CONFIG.sk03TemplateId, sheetId: overallTmplId,
    requestBody: { destinationSpreadsheetId: ssId },
  }))).data.sheetId!;
  const budgetSheetId = (await withRetry(() => sheets.spreadsheets.batchUpdate({ spreadsheetId: ssId, requestBody: { requests: [
    { updateSheetProperties: { properties: { sheetId: internSheetId, title: internSheetName, index: 1 }, fields: 'title,index' } },
    { addSheet: { properties: { title: BUDGET_SHEET, index: 2 } } },
  ]}}))).data.replies![1].addSheet!.properties!.sheetId!;

  // A3 header
  await withRetry(() => sheets.spreadsheets.values.update({ spreadsheetId: ssId, range: `'${staffSheetName}'!A3`, valueInputOption: 'RAW', requestBody: { values: [[`ประจำเดือน  ${THAI_MONTHS[month]}  พ.ศ.  ${beYear}`]] } }));

  // Data rows
  const staffRows = buildOverallRows(staffArray, S, false);
  if (staffRows.length > 0) {
    await withRetry(() => sheets.spreadsheets.values.update({ spreadsheetId: ssId, range: `'${staffSheetName}'!A${S}:V${S + staffRows.length - 1}`, valueInputOption: 'USER_ENTERED', requestBody: { values: staffRows } }));
  }
  const staffLastRow = S + staffArray.length - 1;

  await writeOverallMeta(sheets, ssId, staffSheetName, staffLastRow, false, internSheetName, input, staffSheetName);
  await formatOverallSheet(sheets, ssId, staffSheetId, staffArray, staffLastRow, false);

  // Totals row: M, N, O = SUM immediately below last person, above signature.
  // Use values.append so it auto-extends the grid — no grid limit errors.
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

  // The appended row copies the last person's colours (J department colour,
  // yellow N and Q..V); clear them, then colour the M:O totals.
  await withRetry(() => sheets.spreadsheets.batchUpdate({
    spreadsheetId: ssId,
    requestBody: { requests: totalsRowReqs(staffSheetId, staffTotalRow, 12, true) },
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
  await withRetry(() => sheets.spreadsheets.values.update({ spreadsheetId: ssId, range: `'${internSheetName}'!A3`, valueInputOption: 'RAW', requestBody: { values: [[`ประจำเดือน  ${THAI_MONTHS[month]}  พ.ศ.  ${beYear}`]] } }));

  const internRows = buildOverallRows(internArray, S, true);
  if (internRows.length > 0) {
    await withRetry(() => sheets.spreadsheets.values.update({ spreadsheetId: ssId, range: `'${internSheetName}'!A${S}:V${S + internRows.length - 1}`, valueInputOption: 'USER_ENTERED', requestBody: { values: internRows } }));
  }
  const internLastRow = S + internArray.length - 1;

  await writeOverallMeta(sheets, ssId, internSheetName, internLastRow, true, internSheetName, input, staffSheetName);
  await formatOverallSheet(sheets, ssId, internSheetId, internArray, internLastRow, true);

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
    requestBody: { requests: totalsRowReqs(internSheetId, internTotalRow, 13, false) },
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
  //  2b. งบรายสาขา sheet (new formula: per-department staff budget)
  // ══════════════════════════════════════════════════════════════════
  log(`  [SK03] ${BUDGET_SHEET} sheet (${DEPT_CAPACITY.length} departments)…`);
  await writeBudgetSheet(sheets, ssId, budgetSheetId, staffSheetName, staffLastRow, `ประจำเดือน  ${THAI_MONTHS[month]}  พ.ศ.  ${beYear}`);

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

  await normaliseSK03Fonts(sheets, ssId);

  log(`  [SK03] ✓ Done`);
  return { ssId, staffSheetName, internSheetName };
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
  const targeted = !!(process.env.TARGET_MONTH ?? '').trim();

  // ตรวจสอบ tab (./review-build.ts): off until its tables exist, and never
  // allowed to stop the SK03 build itself.
  let reviewOn = false;
  let reviewV2 = false;
  try {
    reviewOn = await review.reviewReady(supabase);
    reviewV2 = reviewOn && await review.reviewV2(supabase);
  } catch (err: any) {
    // reviewV2 failing leaves reviewOn as found: the copy is still made.
    log(`[Review] ⚠ ${err.message} — ${reviewOn ? 'no Drive id for รวมค่าคะแนน this run' : 'building without the review copy'}`, 'warn');
  }
  const requestId = reviewOn && targeted ? (parseInt(process.env.REVIEW_REQUEST_ID ?? '', 10) || null) : null;
  reviewRequest = requestId ? { supabase, id: requestId } : null;
  await review.markRequest(supabase, requestId, { status: 'running', started_at: new Date().toISOString(), run_url: review.runUrl() });

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
      // A ตรวจสอบ tab request is already marked running: close it first.
      await finishRequest('failed', null, `แม่แบบ SK03 ไม่มีชีต ${required} จึงสร้างไฟล์ไม่ได้`).catch(() => {});
      process.exit(1);
    }
  }
  log('[Pre-flight] ✓ Template OK');

  // Pre-flight: every staff department needs a department multiplier (new formula)
  for (const dept of Object.keys(DEPT_COLORS)) {
    if (dept !== 'INTERN') deptCode(dept); // throws on a department missing from DEPT_CAPACITY
  }

  console.log('══════════════════════════════════════════════════════');
  console.log(' P4P Excel Merge + SK03 Pipeline');
  console.log('══════════════════════════════════════════════════════');
  showDataflow();
  const TARGET_COMPLETE_MONTHS = targeted ? 1 : 2;
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
  if (targeted && completeMonths.length === 0) {
    await finishRequest('failed', null, 'ไฟล์ใน Drive ยังไม่ครบหรือรายชื่อไม่ตรงกับในระบบ จึงยังสร้างไฟล์เดือนนี้ไม่ได้');
  }

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
        nullAfterFill.forEach(p => log(`    • row #${p.index ?? '?'}`, 'warn'));
        if (targeted) await finishRequest('failed', null, `ยังมี ${nullAfterFill.length} คนที่ไม่มีคะแนน จึงยังสร้างไฟล์ไม่ได้`);
        results.skipped++; console.log('└─ skipped (null scores)\n'); continue;
      }
      log('  → ✓ All scores present');

      // Step 5
      log('  [Step 5] Merging…');
      const merged = await mergeAndUpload(drive, driveData.files, sbData, key, reviewOn);
      if (!merged) {
        if (targeted) await finishRequest('failed', null, 'ไม่มีไฟล์ของแพทย์ให้รวม');
        results.skipped++; console.log('└─ skipped\n'); continue;
      }

      // Step 6 — the SK03, with the month's budget (staff Y9) and per P4P
      // (intern W9) from review_inputs, as saved on the overview page (Pong,
      // 2026-11-11: one place in Supabase, not FORMULA.md). Read whether or
      // not the rest of the review is installed; no row leaves both empty.
      const input = await review.loadReviewInput(supabase, key);
      log(`  [Step 6] Creating SK03 spreadsheet… (budget ${input ? `${input.budget} · per P4P ${input.per_p4p}` : 'none saved → empty'})`);
      const sk03 = await createSK03(drive, sheets, sbData, key, supabase, input);
      // Pong's Telegram when the numbers saved on the overview page are in.
      await notifyBudgetBuilt(supabase, key, input, sk03.ssId);

      // Step 7 — copy for the ตรวจสอบ tab. A failure here leaves the SK03
      // built but ends the job red so 1.2 alerts.
      if (reviewOn) {
        log('  [Step 7] Saving files and checks for the ตรวจสอบ tab…');
        try {
          const built = await review.packageReviewBuild({
            drive, sheets, supabase, monthKey: key, ...sk03,
            persons: sbData, docs: merged.docs, mergedBuffer: merged.buffer,
            mergedFileId: merged.uploaded.id ?? '', v2: reviewV2,
            input, requestId,
          });
          if (targeted) await finishRequest('done', built.id, '');
        } catch (err: any) {
          console.error(`  [Review] ✗ ${err.stack ?? err.message}`);
          results.failed.push({ key, error: `review copy: ${err.message}` });
          if (targeted) await finishRequest('failed', null, `สร้างไฟล์แล้ว แต่เก็บสำเนาให้หน้าตรวจสอบไม่สำเร็จ: ${err.message}`);
          console.log('└─ SK03 built, review copy failed\n');
          continue;
        }
      }

      results.processed++;
      console.log('└─ ✓ complete\n');
    } catch (err: any) {
      console.error(`  [ERROR] ${err.stack ?? err.message}`);
      results.failed.push({ key, error: err.message });
      if (targeted) await finishRequest('failed', null, `สร้างไฟล์ไม่สำเร็จ: ${err.message}`);
      console.log('└─ failed\n');
      // NOT a break/return — the other discovered complete month still runs.
    }
  }

  // ── Older months under review ────────────────────────────────────
  // A month older than the ones built above whose ตรวจสอบ review is on the
  // auditee's side (a doctor re-sent a file after it left the latest two,
  // say) gets the tab's own one-month rebuild if its newest build is out of
  // date. Queued, not built here: the relay starts it once this run ends,
  // so this job stays inside the time a waiting tab request is given.
  if (reviewOn && !targeted && completeMonths.length >= TARGET_COMPLETE_MONTHS) {
    const oldest = completeMonths.reduce((a, m) => (m.key < a ? m.key : a), completeMonths[0].key);
    console.log('┌─ ตรวจสอบ tab, older months ───────────────────────────');
    await review.queueOutdatedReviewMonths(supabase, months.map((m) => m.key).filter((k) => k < oldest), reviewV2);
    console.log('└─ done\n');
  }

  console.log('══════════════════════════════════════════════════════');
  console.log(` ✓ Processed: ${results.processed}`);
  console.log(` ⊘ Skipped  : ${results.skipped}`);
  console.log(` ✗ Failed   : ${results.failed.length}`);
  results.failed.forEach(f => console.log(`     ${f.key}: ${f.error}`));
  console.log('');
  // A failed month still lets the other month run (above), but the job must
  // end red so that 1.2 sends the failure alert. After PR #248 every SK03
  // build stopped half-way (no department sheets) while the run showed green.
  if (results.failed.length > 0) process.exitCode = 1;
  if (reviewRequest) await finishRequest('failed', null, 'การสร้างไฟล์หยุดก่อนเสร็จ');
}

// The ตรวจสอบ tab's "build this month now" request this run answers, if any.
let reviewRequest: { supabase: SupabaseClient; id: number } | null = null;

/** Closes the tab's request once; later calls do nothing. */
async function finishRequest(status: 'done' | 'failed', buildId: string | null, error: string): Promise<void> {
  if (!reviewRequest) return;
  const { supabase, id } = reviewRequest;
  reviewRequest = null;
  await review.markRequest(supabase, id, {
    status, build_id: buildId, error: error.slice(0, 500), finished_at: new Date().toISOString(),
  });
}

main().catch(async (err: any) => {
  console.error('\nFatal:', err.stack ?? err);
  await finishRequest('failed', null, `สร้างไฟล์ไม่สำเร็จ: ${err.message ?? err}`).catch(() => {});
  process.exit(1);
});
