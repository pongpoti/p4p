/**
 * process/eligible-list.ts — Monthly P4P-eligible physician list (PDF)
 *
 * Runs on the 1st of every month. Reads that month's just-provisioned
 * roster table (public."YYYY_MM", BE year) from Supabase, groups the
 * physicians by department, and renders a Thai-language PDF — one section
 * per department, each sorted by name (Thai collation) — which is then
 * uploaded (overwriting any previous file of the same name) to a fixed
 * Google Drive folder.
 *
 * Output: eligible_<BEyear><MM>.pdf → uploaded to ELIGIBLE_FOLDER_ID.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { drive_v3 } from 'googleapis';

const { createClient } = require('@supabase/supabase-js') as typeof import('@supabase/supabase-js');
const fs               = require('fs') as typeof import('fs');
const path             = require('path') as typeof import('path');
const { Readable }     = require('stream') as typeof import('stream');
const {
  log, withRetry, createDriveClient, driveListAll,
} = require('./lib') as typeof import('./lib');

// ═══════════════════════════════════════════════════════════════════
//  Config
// ═══════════════════════════════════════════════════════════════════
interface Config {
  supabase: {
    url: string | undefined;
    key: string | undefined;
  };
  folderId: string | undefined;
  fontDir: string;
}

const CONFIG: Config = {
  supabase: {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_KEY,
  },
  // Destination folder for the monthly eligible-physicians PDF.
  //
  // Was hardcoded. A Drive folder id is a LOCATOR, not a secret — but this
  // repository was public, so the literal was a direct address for a folder
  // shared "anyone with the link".
  folderId: process.env.P4P_ELIGIBLE_FOLDER_ID,
  fontDir:  path.join(__dirname, '..', 'src', 'fonts'),
};

if (!CONFIG.folderId) {
  console.error('P4P_ELIGIBLE_FOLDER_ID is not set — refusing to run.');
  process.exit(1);
}

const THAI_MONTHS: Record<number, string> = {
  1: 'มกราคม',   2: 'กุมภาพันธ์', 3: 'มีนาคม',
  4: 'เมษายน',   5: 'พฤษภาคม',   6: 'มิถุนายน',
  7: 'กรกฎาคม',  8: 'สิงหาคม',   9: 'กันยายน',
  10: 'ตุลาคม', 11: 'พฤศจิกายน', 12: 'ธันวาคม',
};

/** Escape a value before interpolating it into the PDF-render HTML template. */
function escHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ═══════════════════════════════════════════════════════════════════
//  Data shapes
// ═══════════════════════════════════════════════════════════════════

/** A row from the month's roster table (public."YYYY_MM"). Fetched via
 *  select('*') because the column set has drifted across months in the
 *  past — only the fields this script actually reads are named below. */
interface RosterRow {
  firstname?: string | null;
  lastname?: string | null;
  department?: string | null;
  prefix?: string | null;
  position?: string | null;
  type?: string | null;
  rank?: string | null;
  [key: string]: unknown;
}

interface TargetMonth {
  key: string;
  beYear: number;
  month: number;
  fileName: string;
}

interface DeptGroup {
  dept: string;
  rows: RosterRow[];
}

// ═══════════════════════════════════════════════════════════════════
//  Step 1 — target month key: the Bangkok "current" month (the one just
//  provisioned by provision-month.yml the day before this runs).
// ═══════════════════════════════════════════════════════════════════
function getTargetMonth(): TargetMonth {
  // Manual override (workflow_dispatch "target_month" input) — force a
  // specific month instead of "whatever month it is right now in Bangkok".
  // Format: "<BE year>-<month>", e.g. "2569-07" for July 2026 CE.
  const override = process.env.TARGET_MONTH?.trim();
  if (override) {
    const m = /^(\d{4})-(\d{1,2})$/.exec(override);
    const beYear = m ? Number(m[1]) : NaN;
    const month  = m ? Number(m[2]) : NaN;
    if (!m || month < 1 || month > 12) {
      throw new Error(`Invalid TARGET_MONTH "${override}" — expected "<BE year>-<month>", e.g. "2569-07".`);
    }
    const mm = String(month).padStart(2, '0');
    return { key: `${beYear}_${mm}`, beYear, month, fileName: `eligible_${beYear}-${mm}.pdf` };
  }

  const now    = new Date(Date.now() + 7 * 60 * 60 * 1000); // Bangkok = UTC+7
  const beYear = now.getUTCFullYear() + 543;
  const month  = now.getUTCMonth() + 1;
  const mm     = String(month).padStart(2, '0');
  return { key: `${beYear}_${mm}`, beYear, month, fileName: `eligible_${beYear}-${mm}.pdf` };
}

/** Bangkok "generated at" timestamp, e.g. "1 ส.ค. 2568, 09.00 น." */
function formatRunTime(): string {
  const now    = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const day    = now.getUTCDate();
  const month  = now.getUTCMonth() + 1;
  const year   = now.getUTCFullYear() + 543;
  const hour   = String(now.getUTCHours()).padStart(2, '0');
  const minute = String(now.getUTCMinutes()).padStart(2, '0');
  return `${day} ${THAI_MONTHS[month]} ${year}, ${hour}.${minute} น.`;
}

// ═══════════════════════════════════════════════════════════════════
//  Step 2 — fetch the month's roster from Supabase
// ═══════════════════════════════════════════════════════════════════
async function fetchRoster(supabase: SupabaseClient, monthKey: string): Promise<RosterRow[]> {
  // select('*') rather than naming columns: roster table shape has drifted
  // across months in the past (see process/process.ts's sbVal() fallback
  // pattern), and an explicit select() 400s hard on a missing column where
  // '*' just omits it — fields are read with a '' fallback below regardless.
  const { data, error } = await supabase.from(monthKey).select('*');

  if (error) {
    throw new Error(`Failed to read roster table "${monthKey}": ${error.message}`);
  }
  return data ?? [];
}

// ═══════════════════════════════════════════════════════════════════
//  Step 3 — group by department, Thai-sorted (ascending, INTERN last),
//  rows within each department sorted by name (Thai collation).
// ═══════════════════════════════════════════════════════════════════
function sortDepartments(depts: string[]): string[] {
  const nonIntern = [...depts].filter(d => d !== 'INTERN').sort((a, b) => a.localeCompare(b, 'th'));
  return depts.includes('INTERN') ? [...nonIntern, 'INTERN'] : nonIntern;
}

function groupByDepartment(rows: RosterRow[]): DeptGroup[] {
  const byDept = new Map<string, RosterRow[]>();
  for (const r of rows) {
    const dept = (r.department ?? '').trim() || 'ไม่ระบุ';
    if (!byDept.has(dept)) byDept.set(dept, []);
    byDept.get(dept)!.push(r);
  }

  return sortDepartments([...byDept.keys()]).map(dept => ({
    dept,
    rows: byDept.get(dept)!.sort((a, b) => {
      const nameA = `${a.firstname ?? ''} ${a.lastname ?? ''}`.trim();
      const nameB = `${b.firstname ?? ''} ${b.lastname ?? ''}`.trim();
      return nameA.localeCompare(nameB, 'th');
    }),
  }));
}

// ═══════════════════════════════════════════════════════════════════
//  Step 4 — HTML template (Thai fonts embedded as base64 — no network
//  dependency, no garbled/missing glyphs on the CI runner).
// ═══════════════════════════════════════════════════════════════════
function loadFontFaceCss(): string {
  const regular = fs.readFileSync(path.join(CONFIG.fontDir, 'Sarabun-Regular.woff2')).toString('base64');
  const bold    = fs.readFileSync(path.join(CONFIG.fontDir, 'Sarabun-Bold.woff2')).toString('base64');
  return `
    @font-face {
      font-family: 'Sarabun';
      font-weight: 400;
      src: url(data:font/woff2;base64,${regular}) format('woff2');
    }
    @font-face {
      font-family: 'Sarabun';
      font-weight: 700;
      src: url(data:font/woff2;base64,${bold}) format('woff2');
    }
  `;
}

function buildCoverHtml(
  { beYear, month }: Pick<TargetMonth, 'beYear' | 'month'>,
  totalCount: number,
  deptCount: number,
  runTime: string
): string {
  return `
    <section class="cover">
      <div class="cover-hospital">โรงพยาบาลสมุทรสาคร</div>
      <h1 class="cover-title">รายชื่อแพทย์ผู้มีสิทธิ์ได้รับค่าตอบแทน<br>ตามผลการปฏิบัติงาน (P4P)</h1>
      <div class="cover-month">ประจำเดือน${THAI_MONTHS[month]} พ.ศ. ${beYear}</div>
      <div class="cover-stats">
        <div class="stat"><span class="stat-num">${totalCount}</span><span class="stat-label">แพทย์ทั้งหมด</span></div>
        <div class="stat"><span class="stat-num">${deptCount}</span><span class="stat-label">กลุ่มงาน</span></div>
      </div>
      <div class="cover-footer">จัดทำเมื่อ ${runTime}</div>
    </section>`;
}

function buildDeptSectionHtml({ dept, rows }: DeptGroup): string {
  const displayDept = dept === 'INTERN' ? 'แพทย์เพิ่มพูนทักษะ (INTERN)' : dept;

  const bodyRows = rows.length === 0
    ? `<tr><td class="no-data" colspan="5">ไม่มีข้อมูล</td></tr>`
    : rows.map((r, i) => {
        const fullname = `${r.firstname ?? ''} ${r.lastname ?? ''}`.trim();
        const nameCell = `${fullname} (${r.prefix ?? ''})`;
        return `
        <tr class="${i % 2 === 1 ? 'alt' : ''}">
          <td class="num">${i + 1}</td>
          <td class="name">${escHtml(nameCell)}</td>
          <td>${escHtml(r.position ?? '')}</td>
          <td>${escHtml(r.type ?? '')}</td>
          <td>${escHtml(r.rank ?? '')}</td>
        </tr>`;
      }).join('');

  return `
    <section class="dept-section">
      <div class="dept-header">
        <span class="dept-name">${escHtml(displayDept)}</span>
        <span class="dept-count">${rows.length} คน</span>
      </div>
      <table>
        <thead>
          <tr>
            <th class="th-num">ลำดับ</th>
            <th>ชื่อ - นามสกุล</th>
            <th>ตำแหน่ง</th>
            <th>ประเภท</th>
            <th>ระดับ</th>
          </tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </section>`;
}

function buildHtml(target: TargetMonth, groups: DeptGroup[], runTime: string): string {
  const totalCount = groups.reduce((sum, g) => sum + g.rows.length, 0);
  const cover       = buildCoverHtml(target, totalCount, groups.length, runTime);
  const deptSections = groups.map(buildDeptSectionHtml).join('');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  ${loadFontFaceCss()}
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Sarabun', sans-serif;
    color: #1e2d3d;
    font-size: 13px;
    line-height: 1.5;
  }

  /* ── Cover page (front matter) ── */
  .cover {
    height: 277mm; /* A4 minus margins */
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    page-break-after: always;
  }
  .cover-hospital { font-size: 20px; font-weight: 700; color: #1e3a5f; margin-bottom: 40px; }
  .cover-title    { font-size: 26px; font-weight: 700; line-height: 1.7; margin-bottom: 30px; }
  .cover-month    { font-size: 20px; color: #4472C4; font-weight: 700; margin-bottom: 50px; }
  .cover-stats    { display: flex; gap: 60px; margin-bottom: 60px; }
  .stat           { display: flex; flex-direction: column; align-items: center; }
  .stat-num       { font-size: 34px; font-weight: 700; color: #1e3a5f; }
  .stat-label     { font-size: 15px; color: #666; }
  .cover-footer   { font-size: 13px; color: #888; font-style: italic; }

  /* ── Department section (own front matter + table) ── */
  .dept-section { page-break-before: always; }
  .dept-header {
    background: #1e3a5f;
    color: #fff;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 18px;
    border-radius: 6px 6px 0 0;
  }
  .dept-name  { font-size: 18px; font-weight: 700; }
  .dept-count {
    font-size: 13px;
    background: rgba(255,255,255,0.2);
    padding: 3px 12px;
    border-radius: 12px;
    font-weight: 700;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    background: #fff;
    border: 1px solid #1e3a5f;
  }
  thead tr { background: #D9E1F2; }
  th {
    padding: 8px 12px;
    text-align: left;
    font-weight: 700;
    font-size: 13px;
    color: #2c3e50;
    border-bottom: 2px solid #b4c6e0;
    border-right: 1px solid #b4c6e0;
    white-space: nowrap;
  }
  td {
    padding: 7px 12px;
    border-bottom: 1px solid #e8edf5;
    border-right: 1px solid #e8edf5;
    vertical-align: middle;
    font-size: 13px;
  }
  th:last-child, td:last-child { border-right: none; }
  tr.alt { background: #F3F6FB; }
  tr:last-child td { border-bottom: none; }
  .num, .th-num { width: 40px; text-align: center; white-space: nowrap; }
  .no-data {
    text-align: center; color: #bbb; font-style: italic;
    padding: 18px; font-size: 13px;
  }

  thead { display: table-header-group; } /* repeat header on page breaks */
  tr    { page-break-inside: avoid; }
</style>
</head>
<body>
  ${cover}
  ${deptSections}
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════════
//  Step 5 — render to PDF via Puppeteer
// ═══════════════════════════════════════════════════════════════════
async function renderPdf(html: string): Promise<Uint8Array> {
  const puppeteer = require('puppeteer') as typeof import('puppeteer');
  const browser   = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    // @ts-expect-error - puppeteer's SetContentWaitForOptions type excludes
    // 'networkidle0' (only page.goto() declares it), but the runtime accepts
    // it identically; keeping it preserves the original wait behaviour.
    await page.setContent(html, { waitUntil: 'networkidle0' });
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '10mm', bottom: '10mm', left: '12mm', right: '12mm' },
    });
  } finally {
    await browser.close();
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Step 6 — upload / overwrite in Drive
// ═══════════════════════════════════════════════════════════════════
async function uploadPdf(drive: drive_v3.Drive, buffer: Uint8Array, fileName: string): Promise<drive_v3.Schema$File> {
  const mime     = 'application/pdf';
  const folderId = CONFIG.folderId;
  const safeName = fileName.replace(/'/g, "\\'");

  const existing = await driveListAll(drive, {
    q: `'${folderId}' in parents and name='${safeName}' and trashed=false`,
    fields: 'nextPageToken, files(id, name)',
    pageSize: 10,
  });

  if (existing.length > 0) {
    const [first, ...dupes] = existing;
    for (const d of dupes) {
      await withRetry(() => drive.files.delete({ fileId: d.id! }));
      log(`  [Drive] Deleted duplicate: ${d.id}`, 'warn');
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

  log(`  [Drive] Creating "${fileName}"`);
  const res = await withRetry(() => drive.files.create({
    requestBody: { name: fileName, parents: [folderId!], mimeType: mime },
    media: { mimeType: mime, body: Readable.from([buffer]) },
    fields: 'id, name, webViewLink',
  }));
  return res.data;
}

// ═══════════════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  const target = getTargetMonth();
  log(`Generating eligible-physician PDF for ${target.key} → ${target.fileName}`);

  const supabase = createClient(CONFIG.supabase.url!, CONFIG.supabase.key!);
  const rows      = await fetchRoster(supabase, target.key);

  if (rows.length === 0) {
    log(`No roster rows found for "${target.key}" — nothing to generate.`, 'warn');
    return;
  }

  const groups   = groupByDepartment(rows);
  const runTime  = formatRunTime();
  const html     = buildHtml(target, groups, runTime);

  log(`Rendering PDF (${groups.length} departments, ${rows.length} physicians)…`);
  const pdfBuffer = await renderPdf(html);

  const drive  = createDriveClient();
  const result = await uploadPdf(drive, pdfBuffer, target.fileName);
  log(`Done: ${result.name} (${result.id})`);
}

if (require.main === module) {
  main().catch((err: any) => {
    console.error('❌ eligible-list.js failed:', err);
    process.exit(1);
  });
}

export = { getTargetMonth, groupByDepartment, sortDepartments, buildHtml };
