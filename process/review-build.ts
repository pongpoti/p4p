/**
 * process/review-build.ts — the ตรวจสอบ (review) tab's side of workflow 2.2.
 *
 * After process.ts has built a month's merged file and SK03, this keeps a
 * copy of both for the dashboard's review tab:
 *
 *   1. reads the built SK03 back (staff/intern sheets, Y9, W9 and every
 *      department sheet) and exports it as .xlsx;
 *   2. for every person on the roster runs the two automatic checks:
 *        เทียบคะแนน  staff/intern K   vs the score the workflow takes from
 *                    the doctor's own sheet (lib/review-core.ts
 *                    workflowTotal: lib/p4p-score.ts resolveScore, its full
 *                    rule, on the sheet's saved values)
 *        เทียบเงิน    staff/intern N   vs the department sheet's F
 *                    (ตามสัดส่วนวิชาชีพ)
 *   3. uploads both files to the private Storage bucket review-files, and
 *      writes review_builds (one row, with SHA-256 of each file and any
 *      build-level problem) and review_build_people (one row per person,
 *      with a snapshot of the doctor's sheet for the viewer);
 *   4. drops old builds no round refers to (keeps the newest three).
 *
 * The auditee sends the newest build as it is (no download or upload since
 * scripts/review-tab-2026-11-auditee.sql): the copies kept here are the
 * record of exactly what was checked. The tab links the files in Drive, so
 * every run also stores the Drive ids of the SK03 (a new Google Sheet each
 * run) and the รวมค่าคะแนน file on the newest build, kept or not.
 *
 * Also: the month's budget and per P4P from the tab (review_inputs; per
 * P4P = budget ÷ N), kept on the build record only (since 2026-11-11 the
 * SK03 leaves staff Y9 and intern W9 empty),
 * and the status of a "build this month now" request from the tab
 * (review_requests).
 *
 * Until scripts/review-tab-2026-11.sql has been run, reviewReady() is false
 * and 2.2 builds exactly as before; until the second file has been run,
 * reviewV2() is false and the Drive id of the รวมค่าคะแนน file is not kept.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { drive_v3, sheets_v4 } from 'googleapis';

const crypto  = require('crypto') as typeof import('crypto');
const ExcelJS = require('exceljs') as typeof import('exceljs');
const { log, withRetry, normaliseName } = require('./lib') as typeof import('./lib');
type Resolve = (rows: Record<string, unknown>[]) => { score: number | null; method: string };
// The rule that put each score in SK03 K (a port of automation/claude-analyst.ts).
const p4p = require('../lib/p4p-score') as { resolveScore: Resolve };
const core = require('../lib/review-core') as {
  workflowTotal(grid: unknown[][], uncached: Set<string>, resolve: Resolve): StatedTotal;
  scoreCheck(a: number | null | undefined, b: number | null | undefined): Check;
  moneyCheck(a: number | null | undefined, b: number | null | undefined): Check;
  w9Rate(formula: unknown): number | null;
  cellName(r: number, c: number): string;
};

type Check = 'match' | 'mismatch' | 'missing';
interface StatedTotal { value: number | null; cell: string | null; how: string }

const BUCKET = 'review-files';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SNAPSHOT_ROWS = 200;
const SNAPSHOT_COLS = 60;
const KEEP_UNUSED_BUILDS = 3;

export interface ReviewInput { budget: number; per_p4p: number }

/** A doctor's sheet as the review tab's viewer shows it (0-based cells). */
export interface SheetGrid {
  sheet: string;
  rows: number;
  cols: number;
  cells: [number, number, string | number][];
  merges: string[];
}

export interface DocInfo {
  sheetName: string;   // the sheet's name in the merged file
  sha256: string;      // the doctor's file as on Drive
  stated: StatedTotal;
  grid: SheetGrid | null;
}

export interface ReviewPerson {
  index: number | string | null;
  prefix: string;
  firstname: string;
  lastname: string;
  fullname: string;
  department: string;
  submitted_at?: string | null;
}

/**
 * The review tables are not installed: a definite "no such table" code, or
 * that wording on an answer with no code. PGRST002 ("Could not query the
 * database for the schema cache. Retrying.") is a passing outage, not this.
 */
export const missingTable = (e: { code?: string | null; message?: string } | null | undefined): boolean =>
  !!e && (e.code === 'PGRST205' || e.code === '42P01' ||
    (!e.code && /^relation .* does not exist|could not find the table/i.test(e.message ?? '')));

/** True once scripts/review-tab-2026-11.sql is in the database. */
export async function reviewReady(supabase: SupabaseClient): Promise<boolean> {
  const { error } = await supabase.from('review_builds').select('id').limit(1);
  if (!error) return true;
  if (missingTable(error)) {
    log('  [Review] review tables not installed yet (scripts/review-tab-2026-11.sql) — no copy for the ตรวจสอบ tab', 'warn');
    return false;
  }
  throw new Error(`review_builds read error: ${error.message}`);
}

/**
 * True once scripts/review-tab-2026-11-auditee.sql is in the database too
 * (review_builds.merged_file_id exists). A passing outage is an error.
 */
export async function reviewV2(supabase: SupabaseClient): Promise<boolean> {
  const { error } = await supabase.from('review_builds').select('merged_file_id').limit(1);
  if (!error) return true;
  if (error.code === '42703' || error.code === 'PGRST204' || (!error.code && /column .* does not exist/i.test(error.message ?? ''))) {
    log('  [Review] second review SQL file not run yet (scripts/review-tab-2026-11-auditee.sql) — no Drive id for รวมค่าคะแนน', 'warn');
    return false;
  }
  throw new Error(`review_builds read error: ${error.message}`);
}

/** The first month the ตรวจสอบ tab covers (lib/review-server.ts FIRST_MONTH). */
export const REVIEW_FIRST_MONTH = '2569_08';

/**
 * The months among `keys` whose ตรวจสอบ review is on the auditee's side:
 * from ส.ค. 2569 on, with no round sent yet or the live one sent back (the
 * SQL's review_auditee_turn). A month the auditor has, or one approved, is
 * left as it is.
 */
export async function auditeeSideMonths(supabase: SupabaseClient, keys: string[]): Promise<Set<string>> {
  const want = keys.filter((k) => /^\d{4}_\d{2}$/.test(k) && k >= REVIEW_FIRST_MONTH);
  if (!want.length) return new Set();
  const { data, error } = await supabase.from('review_rounds').select('month')
    .in('month', want).in('status', ['submitted', 'approved']);
  if (error) {
    if (missingTable(error)) return new Set();
    throw new Error(`review_rounds read error: ${error.message}`);
  }
  const theirs = new Set(((data ?? []) as { month: string }[]).map((r) => r.month));
  return new Set(want.filter((k) => !theirs.has(k)));
}

const cents = (n: number): number => Math.round(n * 100);

/**
 * Why the newest build of `month` is no longer what the tab needs, or null:
 * none yet, no รวมค่าคะแนน link (once the second SQL file is in), not the
 * budget / per P4P typed in the tab, or people changed since it was built
 * (review_build_stale: a re-sent file, a score, a department). The same
 * things that stop the auditee from sending (review_submit_round).
 */
export async function reviewBuildOutdated(supabase: SupabaseClient, month: string, v2: boolean): Promise<string | null> {
  const { data, error } = await supabase.from('review_builds')
    .select(v2 ? 'id, budget, per_p4p, merged_file_id' : 'id, budget, per_p4p')
    .eq('month', month).order('built_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`review_builds read error: ${error.message}`);
  const b = data as { id: string; budget: number | null; per_p4p: number | null; merged_file_id?: string | null } | null;
  if (!b) return 'no build yet';
  if (v2 && !b.merged_file_id) return 'no รวมค่าคะแนน link';
  const input = await loadReviewInput(supabase, month);
  if (input && (cents(input.budget) !== cents(Number(b.budget)) || cents(input.per_p4p) !== cents(Number(b.per_p4p)))) {
    return 'not the budget / per P4P typed in the tab';
  }
  if (v2) {
    const { data: n, error: e } = await supabase.rpc('review_build_stale', { p_month: month, p_build: b.id });
    if (e) throw new Error(`review_build_stale error: ${e.message}`);
    if (Number(n) > 0) return `${Number(n)} people changed since`;
  }
  return null;
}

/**
 * For the nightly run: each month among `older` (months older than the ones
 * it just built) whose review is on the auditee's side and whose newest
 * build is out of date gets the tab's own one-month rebuild request
 * (review_request_build, as the สร้างไฟล์ใหม่ button does), which the
 * always-on relay starts after this run. Built in this run instead, they
 * would push the job past the time the SQL gives a waiting request.
 * Never throws; returns the months queued.
 */
export async function queueOutdatedReviewMonths(supabase: SupabaseClient, older: string[], v2: boolean): Promise<string[]> {
  const queued: string[] = [];
  let side: Set<string>;
  try {
    side = await auditeeSideMonths(supabase, older);
  } catch (err: any) {
    log(`  [Review] ⚠ ${err.message} — no rebuilds queued for older months`, 'warn');
    return queued;
  }
  for (const month of [...side].sort().reverse()) {
    try {
      const why = await reviewBuildOutdated(supabase, month, v2);
      if (!why) { log(`  [Review] ${month}: under review, build up to date`); continue; }
      const { error } = await supabase.rpc('review_request_build', { p_month: month, p_reason: 'rebuild', p_actor: '2.2 nightly' });
      if (error) throw new Error(`review_request_build error: ${error.message}`);
      log(`  [Review] ${month}: under review, ${why} — rebuild queued for after this run`);
      queued.push(month);
    } catch (err: any) {
      log(`  [Review] ⚠ ${month}: ${err.message}`, 'warn');
    }
  }
  return queued;
}

/** The month's budget and per P4P from the tab, or null. */
export async function loadReviewInput(supabase: SupabaseClient, monthKey: string): Promise<ReviewInput | null> {
  const { data, error } = await supabase.from('review_inputs').select('budget, per_p4p').eq('month', monthKey).maybeSingle();
  if (error) {
    if (missingTable(error)) return null;
    throw new Error(`review_inputs read error: ${error.message}`);
  }
  if (!data) return null;
  const budget = Number(data.budget), per_p4p = Number(data.per_p4p);
  return budget > 0 && per_p4p > 0 ? { budget, per_p4p } : null;
}

/** Updates a review_requests row; never throws (the build matters more). */
export async function markRequest(supabase: SupabaseClient, id: number | null, patch: Record<string, unknown>): Promise<void> {
  if (!id) return;
  const { error } = await supabase.from('review_requests').update(patch).eq('id', id);
  if (error) log(`  [Review] ⚠ could not update request ${id}: ${error.message}`, 'warn');
}

export function runUrl(): string {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  return GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID
    ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}` : '';
}

const sha256 = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex');

// ─── The doctor's own file ────────────────────────────────────────────────

/** A cell's saved value: a formula's cached result, or null when Excel never saved one. */
export function savedValue(v: unknown): { value: string | number | null; uncached: boolean } {
  if (v === null || v === undefined) return { value: null, uncached: false };
  if (typeof v === 'number') return { value: v, uncached: false };
  if (typeof v === 'string') return { value: v, uncached: false };
  if (typeof v === 'boolean') return { value: v ? 'TRUE' : 'FALSE', uncached: false };
  if (v instanceof Date) return { value: v.toISOString().slice(0, 10), uncached: false };
  const o = v as Record<string, unknown>;
  if (Array.isArray(o.richText)) return { value: (o.richText as { text: string }[]).map((r) => r.text).join(''), uncached: false };
  if ('formula' in o || 'sharedFormula' in o) {
    if (o.result === undefined || o.result === null) return { value: null, uncached: true };
    const r = savedValue(o.result);
    return { value: r.value, uncached: false };
  }
  if ('error' in o) return { value: String(o.error), uncached: false };
  if ('text' in o) return { value: String(o.text), uncached: false };
  return { value: String(v), uncached: false };
}

/**
 * A cell as the submission pipeline reads it into a row (automation/index.ts
 * rowsOfSheet, lib/p4p-score.ts rowsFromWorksheet), so workflowTotal sees the
 * numbers the doctor's score was taken from: a formula's cell.result (a
 * shared-formula copy's only when it is a number, a merged copy's none),
 * dates as ISO text, rich text joined. `uncached` is a formula Excel saved
 * no value for (a saved 0 is a value).
 */
export function pipelineValue(cell: { value: unknown; result?: unknown; master?: { result?: unknown } }): { value: unknown; uncached: boolean } {
  const val = cell.value as Record<string, unknown> | null | undefined;
  const isMaster = val !== null && typeof val === 'object' && 'formula' in val;
  const isClone = val !== null && typeof val === 'object' && 'sharedFormula' in val && !('formula' in val);
  if (isMaster || isClone) {
    const r = cell.result;
    const saved = (cell.master ?? cell).result;
    const uncached = saved === null || saved === undefined;
    if (isClone) return { value: typeof r === 'number' ? r : null, uncached };
    if (r === null || r === undefined) return { value: null, uncached };
    return { value: r instanceof Date ? r.toISOString() : r, uncached };
  }
  if (val === null || val === undefined) return { value: null, uncached: false };
  if (val instanceof Date) return { value: val.toISOString(), uncached: false };
  if (typeof val === 'object' && Array.isArray(val.richText)) {
    return { value: (val.richText as { text?: string }[]).map((r) => r.text || '').join(''), uncached: false };
  }
  if (typeof val === 'object' && 'text' in val) return { value: String(val.text || ''), uncached: false };
  return { value: val, uncached: false };
}

/**
 * Reads the sheet merge.py copies into the merged file (the first sheet with
 * more than one row of data) and returns its stated total and a snapshot.
 * The total is read from the cells as the pipeline reads them
 * (pipelineValue), the snapshot from their saved values (savedValue).
 */
export async function analyseDoctorFile(buffer: Buffer): Promise<{ stated: StatedTotal; grid: SheetGrid | null; sha256: string }> {
  const fileSha = sha256(buffer);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const dataRows = (ws: import('exceljs').Worksheet): number => {
    let n = 0;
    ws.eachRow({ includeEmpty: false }, (row) => {
      if ((row.values as unknown[]).some((v) => v !== null && v !== undefined && v !== '')) n++;
    });
    return n;
  };
  const ws = wb.worksheets.find((w) => dataRows(w) > 1);
  if (!ws) return { stated: { value: null, cell: null, how: 'empty' }, grid: null, sha256: fileSha };

  // The whole sheet, as the pipeline read it when it saved the score.
  const scoreGrid: unknown[][] = [];
  const uncached = new Set<string>();
  const cells: [number, number, string | number][] = [];
  let maxR = 0, maxC = 0;
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const r = rowNumber - 1;
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const c = colNumber - 1;
      const p = pipelineValue(cell as unknown as Parameters<typeof pipelineValue>[0]);
      if (p.uncached) uncached.add(core.cellName(r, c));
      if (p.value !== null && p.value !== undefined && p.value !== '') (scoreGrid[r] ??= [])[c] = p.value;
      if (r >= SNAPSHOT_ROWS || c >= SNAPSHOT_COLS) return;
      const { value } = savedValue(cell.value);
      if (value === null || value === '') return;
      cells.push([r, c, typeof value === 'string' && value.length > 120 ? value.slice(0, 120) + '…' : value]);
      maxR = Math.max(maxR, r + 1);
      maxC = Math.max(maxC, c + 1);
    });
  });
  const merges = ((ws as unknown as { model?: { merges?: string[] } }).model?.merges ?? []).slice(0, 300);
  return {
    stated: core.workflowTotal(scoreGrid, uncached, p4p.resolveScore),
    grid: { sheet: ws.name, rows: maxR, cols: maxC, cells, merges },
    sha256: fileSha,
  };
}

// ─── The built SK03, read back ────────────────────────────────────────────

type Row = (string | number | boolean | null | undefined)[];
const num = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) ? v : null);
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

interface OverallRow { row: number; key: string; score: number | null; pay: number | null }
interface DeptRow { row: number; key: string; admin: number | null; pay: number | null; total: number | null; cells: Row }

/** Data rows of a staff/intern sheet read from A8: stops at the totals row (A blank). */
export function overallRows(values: Row[] | undefined, first: number): OverallRow[] {
  const out: OverallRow[] = [];
  for (let i = 0; i < (values?.length ?? 0); i++) {
    const v = values![i] ?? [];
    if (num(v[0]) === null) break;
    out.push({ row: first + i, key: normaliseName(`${str(v[2])} ${str(v[3])}`), score: num(v[10]), pay: num(v[13]) });
  }
  return out;
}

/** Data rows of a department sheet read from A1 (data from row 6, A = running number). */
export function deptRows(values: Row[] | undefined): DeptRow[] {
  const out: DeptRow[] = [];
  let i = 5;
  while (i < (values?.length ?? 0) && num(values![i]?.[0]) === null) i++;
  for (; i < (values?.length ?? 0); i++) {
    const v = values![i] ?? [];
    if (num(v[0]) === null) break;
    out.push({ row: i + 1, key: normaliseName(str(v[1])), admin: num(v[4]), pay: num(v[5]), total: num(v[6]), cells: v.slice(0, 9) });
  }
  return out;
}

export interface PackageOptions {
  drive: drive_v3.Drive;
  sheets: sheets_v4.Sheets;
  supabase: SupabaseClient;
  monthKey: string;
  ssId: string;
  staffSheetName: string;
  internSheetName: string;
  persons: ReviewPerson[];
  docs: Map<string, DocInfo>;
  mergedBuffer: Buffer;
  /** The รวมค่าคะแนน file on Drive (merged_YYYY_MM.xlsx). */
  mergedFileId: string;
  /** scripts/review-tab-2026-11-auditee.sql has been run (reviewV2). */
  v2: boolean;
  input: ReviewInput | null;
  requestId: number | null;
}

/**
 * Steps 1–4 above. Returns the build's id; `reused` when nothing the tab
 * shows has changed since the month's newest build, so that build stays the
 * newest and a file the auditee already downloaded stays valid.
 */
export async function packageReviewBuild(o: PackageOptions): Promise<{ id: string; reused: boolean }> {
  const { sheets, drive, supabase, monthKey, ssId } = o;
  const titles = ((await withRetry(() => sheets.spreadsheets.get({ spreadsheetId: ssId, fields: 'sheets.properties.title' })))
    .data.sheets ?? []).map((s) => s.properties?.title ?? '');
  const deptTitles = titles.filter((t) => t !== o.staffSheetName && t !== o.internSheetName && t !== 'งบรายสาขา');
  const q = (t: string): string => `'${t.replace(/'/g, "''")}'`;

  const got = (await withRetry(() => sheets.spreadsheets.values.batchGet({
    spreadsheetId: ssId,
    valueRenderOption: 'UNFORMATTED_VALUE',
    ranges: [`${q(o.staffSheetName)}!A8:P2000`, `${q(o.internSheetName)}!A8:P2000`, `${q(o.staffSheetName)}!Y9`,
      ...deptTitles.map((t) => `${q(t)}!A1:I2000`)],
  }))).data.valueRanges ?? [];
  const w9 = (await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: ssId, range: `${q(o.internSheetName)}!W9`, valueRenderOption: 'FORMULA',
  }))).data.values?.[0]?.[0];

  const staff = overallRows(got[0]?.values as Row[] | undefined, 8);
  const interns = overallRows(got[1]?.values as Row[] | undefined, 8);
  const sheetBudget = num((got[2]?.values as Row[] | undefined)?.[0]?.[0]);
  const depts = deptTitles.map((name, i) => {
    const values = got[3 + i]?.values as Row[] | undefined;
    const rows = deptRows(values);
    const sum = (k: 'admin' | 'pay' | 'total'): number => rows.reduce((s, r) => s + (r[k] ?? 0), 0);
    return {
      name,
      header: (values ?? []).slice(0, 5).map((r) => (r ?? []).slice(0, 9).map(str)),
      rows, admin: sum('admin'), pay: sum('pay'), total: sum('total'),
    };
  });

  // Match every roster person to their rows. Two people with the same name
  // take the rows in order.
  const take = <T extends { key: string }>(list: T[], key: string, used: Set<T>): T | null => {
    const hit = list.find((r) => r.key === key && !used.has(r));
    if (hit) used.add(hit);
    return hit ?? null;
  };
  const usedOverall = new Set<OverallRow>();
  const usedDept = new Set<DeptRow>();
  const notInSk03: string[] = [], noSheet: string[] = [], notInDept: string[] = [];
  const people = o.persons.filter((p) => p.index != null).map((p) => {
    const isIntern = p.department === 'INTERN';
    const name = normaliseName(`${p.prefix} ${p.firstname} ${p.lastname}`);
    const nameKey = normaliseName(p.fullname);
    const ov = take(isIntern ? interns : staff, nameKey, usedOverall);
    const dept = depts.find((d) => d.name === p.department);
    const dr = dept ? take(dept.rows, name, usedDept) : null;
    const doc = o.docs.get(nameKey) ?? null;
    if (!ov) notInSk03.push(name);
    if (!doc) noSheet.push(name);
    if (ov && !dr) notInDept.push(name);
    return {
      roster_index: String(p.index),
      name,
      department: p.department,
      is_intern: isIntern,
      sk03_row: ov?.row ?? null,
      sk03_score: ov?.score ?? null,
      sk03_pay: ov?.pay ?? null,
      dept_row: dr?.row ?? null,
      dept_pay: dr?.pay ?? null,
      dept_admin: dr?.admin ?? null,
      merged_sheet: doc?.sheetName ?? null,
      stated_total: doc?.stated.value ?? null,
      stated_cell: doc?.stated.cell ?? null,
      stated_how: doc?.stated.how ?? 'no-sheet',
      score_check: core.scoreCheck(ov?.score, doc?.stated.value),
      money_check: core.moneyCheck(ov?.pay, dr?.pay),
      submitted_at: p.submitted_at ?? null,
      sheet: doc?.grid ?? null,
    };
  });

  const problems: Record<string, unknown>[] = [];
  // The SK03 no longer carries the tab's budget / per P4P (Pong,
  // 2026-11-11), so there is no "inputs_not_in_sheet" check.
  if (!o.input) problems.push({ code: 'no_inputs', blocking: true });
  // Names in a fixed order: the roster comes back in no particular order,
  // and past 50 the order would decide which names are kept.
  const someNames = (list: string[]): string[] => [...list].sort().slice(0, 50);
  if (notInSk03.length) problems.push({ code: 'not_in_sk03', blocking: true, count: notInSk03.length, names: someNames(notInSk03) });
  if (noSheet.length) problems.push({ code: 'no_doctor_sheet', blocking: true, count: noSheet.length, names: someNames(noSheet) });
  if (notInDept.length) problems.push({ code: 'not_in_dept_sheet', blocking: false, count: notInDept.length, names: someNames(notInDept) });

  // rowNos: the 1-based sheet row of each element of rows, same order.
  const deptsJson = depts.map((d) => ({
    name: d.name, header: d.header, admin: d.admin, pay: d.pay, total: d.total,
    rows: d.rows.map((r) => r.cells), rowNos: d.rows.map((r) => r.row),
  }));
  // The fingerprint reads people in roster_index order: the roster is read
  // with select('*') and no ORDER BY, and the same month in another order
  // must not make a new newest build (a round being prepared would look out
  // of date for nothing).
  const byIndex = [...people].sort((a, b) => (a.roster_index < b.roster_index ? -1 : a.roster_index > b.roster_index ? 1 : 0));
  const contentSha = crypto.createHash('sha256').update(JSON.stringify({
    v: 2, input: o.input, sheetBudget, w9: str(w9), people: byIndex, depts: deptsJson, problems,
    files: [...o.docs.entries()].map(([k, d]) => [k, d.sheetName, d.sha256]).sort(),
  })).digest('hex');
  const { data: last, error: lastErr } = await supabase.from('review_builds')
    .select('id, content_sha256').eq('month', monthKey).order('built_at', { ascending: false }).limit(1).maybeSingle();
  if (lastErr) throw new Error(`review_builds read: ${lastErr.message}`);
  if (last && last.content_sha256 === contentSha) {
    log(`  [Review] ✓ nothing changed since build ${last.id} — keeping it as the newest`);
    // This run made a new SK03 Sheet (the old one is gone): the tab links
    // the build's ids, so they follow the files.
    const ids: Record<string, string> = { sk03_file_id: ssId };
    if (o.v2) ids.merged_file_id = o.mergedFileId;
    const { error: idErr } = await supabase.from('review_builds').update(ids).eq('id', last.id);
    if (idErr) throw new Error(`review_builds file ids: ${idErr.message}`);
    return { id: last.id as string, reused: true };
  }

  log(`  [Review] Exporting SK03 as .xlsx…`);
  const sk03Buffer = Buffer.from((await withRetry(() => drive.files.export(
    { fileId: ssId, mimeType: XLSX }, { responseType: 'arraybuffer' },
  ))).data as ArrayBuffer);

  const id = crypto.randomUUID();
  const base = `builds/${monthKey}/${id}`;
  const sk03Path = `${base}/SK03_${monthKey}.xlsx`;
  const mergedPath = `${base}/merged_${monthKey}.xlsx`;
  const put = async (p: string, b: Buffer): Promise<void> => {
    const { error } = await supabase.storage.from(BUCKET).upload(p, b, { contentType: XLSX, upsert: false });
    if (error) throw new Error(`storage upload ${p}: ${error.message}`);
  };
  await put(sk03Path, sk03Buffer);
  await put(mergedPath, o.mergedBuffer);

  try {
    const { error } = await supabase.from('review_builds').insert({
      id, month: monthKey, request_id: o.requestId, run_url: runUrl(), sk03_file_id: ssId,
      ...(o.v2 ? { merged_file_id: o.mergedFileId } : {}),
      sk03_path: sk03Path, sk03_sha256: sha256(sk03Buffer), sk03_bytes: sk03Buffer.length,
      merged_path: mergedPath, merged_sha256: sha256(o.mergedBuffer), merged_bytes: o.mergedBuffer.length,
      content_sha256: contentSha,
      budget: o.input?.budget ?? null, per_p4p: o.input?.per_p4p ?? null,
      sheet_budget: sheetBudget, sheet_w9: str(w9),
      people: people.length, staff: staff.length, interns: interns.length,
      pay_total: depts.reduce((s, d) => s + d.total, 0),
      problems,
      depts: deptsJson,
    });
    if (error) throw new Error(`review_builds insert: ${error.message}`);
    for (let i = 0; i < people.length; i += 25) {
      const { error: e2 } = await supabase.from('review_build_people').insert(people.slice(i, i + 25).map((p) => ({ build_id: id, ...p })));
      if (e2) throw new Error(`review_build_people insert: ${e2.message}`);
    }
  } catch (err) {
    await supabase.from('review_builds').delete().eq('id', id);
    await supabase.storage.from(BUCKET).remove([sk03Path, mergedPath]);
    throw err;
  }

  const counts = (k: 'score_check' | 'money_check', v: Check): number => people.filter((p) => p[k] === v).length;
  log(`  [Review] ✓ build ${id}: ${people.length} people · score ${counts('score_check', 'match')} match, ` +
    `${counts('score_check', 'mismatch')} differ, ${counts('score_check', 'missing')} not found · money ` +
    `${counts('money_check', 'match')} match, ${counts('money_check', 'mismatch')} differ, ${counts('money_check', 'missing')} not found` +
    (problems.length ? ` · problems: ${problems.map((p) => p.code).join(', ')}` : ''));

  await cleanupReviewBuilds(supabase, monthKey).catch((e: Error) => log(`  [Review] ⚠ cleanup: ${e.message}`, 'warn'));
  return { id, reused: false };
}

/** Drops builds and uploads that no round uses, keeping the newest builds. */
export async function cleanupReviewBuilds(supabase: SupabaseClient, monthKey: string): Promise<void> {
  const [{ data: builds, error: e1 }, { data: rounds, error: e2 }] = await Promise.all([
    supabase.from('review_builds').select('id, sk03_path, merged_path').eq('month', monthKey).order('built_at', { ascending: false }),
    supabase.from('review_rounds').select('build_id, sk03_upload, merged_upload').eq('month', monthKey),
  ]);
  if (e1 || e2) throw new Error((e1 ?? e2)!.message);
  const keep = new Set<string>((rounds ?? []).map((r) => r.build_id));
  (builds ?? []).slice(0, KEEP_UNUSED_BUILDS).forEach((b) => keep.add(b.id));
  const drop = (builds ?? []).filter((b) => !keep.has(b.id));
  if (drop.length) {
    await supabase.storage.from(BUCKET).remove(drop.flatMap((b) => [b.sk03_path, b.merged_path]));
    const { error } = await supabase.from('review_builds').delete().in('id', drop.map((b) => b.id));
    if (error) throw new Error(error.message);
    log(`  [Review] removed ${drop.length} old build(s)`);
  }
  const usedUploads = new Set<string>((rounds ?? []).flatMap((r) => [r.sk03_upload, r.merged_upload]));
  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
  const { data: ups } = await supabase.from('review_uploads').select('id, path').eq('month', monthKey).lt('created_at', weekAgo);
  const stale = (ups ?? []).filter((u) => !usedUploads.has(u.id));
  if (stale.length) {
    await supabase.storage.from(BUCKET).remove(stale.map((u) => u.path));
    await supabase.from('review_uploads').delete().in('id', stale.map((u) => u.id));
  }
}
