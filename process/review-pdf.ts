/**
 * process/review-pdf.ts — the ตรวจสอบ (review) tab's approval document.
 *
 * Run by workflow 2.8, which the always-on relay (workflow 1) starts when the
 * auditor approves everyone in a month (scripts/review-tab-2026-11.sql
 * review_approve_round sets pdf_status 'queued').
 *
 * For each waiting round (claim_review_pdf) this renders, from the round's
 * own build (review_builds.depts, the department sheets 2.2 read back from
 * the SK03 the auditee sent):
 *
 *   page 1      the cover: the approval stamp, every department's head count,
 *               total and first page, and the numbers and files the round used
 *   then        every department sheet, 13 rows a page and at most 8 on its
 *               last page, which carries the รวม row and the three signatures;
 *               each of these pages has the form's name (SK02_FORM) at the
 *               top right, as the hospital's SK02 form prints it in its header
 *
 * A4 landscape, TH SarabunPSK (src/fonts/THSarabunPSK-*.ttf, the government's
 * standard font; Pong, 2026-11-12), 15 pt body, and the approval date and time (Bangkok) at the
 * bottom right of every page. The PDF goes to the private Storage bucket
 * review-files (pdf/<month>/...) and the round is marked ready
 * (review_pdf_done) or failed (review_pdf_failed). Nothing is emailed or put
 * on Drive. Logs carry no names: this repository and its run logs are public.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

const fs   = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');

const BUCKET = 'review-files';
const FONT_DIR = path.join(__dirname, '..', 'src', 'fonts');
const ROWS_PER_PAGE = 13;
const ROWS_LAST_PAGE = 8;
const MAX_PER_RUN = 12;
const HOSPITAL = 'โรงพยาบาลสมุทรสาคร';
/** The page header (top right) of the hospital's SK02 form, which the department sheets follow. */
export const SK02_FORM = 'แบบฟอร์ม P4P_SK02';

const TH_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const TH_MONTHS_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

export interface PdfDept {
  name: string;
  header: string[][];
  rows: unknown[][];
  admin: number;
  pay: number;
  total: number;
}

export interface PdfData {
  month: string;            // "2569_10"
  roundNo: number;
  rounds: number;           // rounds sent for the month, this one included
  approvedAt: string;
  approvedBy: string;
  approvedPeople: number;
  people: number;           // everyone in the round
  submittedAt: string;
  submittedBy: string;
  reopenedAt: string | null;
  reopenedBy: string;
  reopenReason: string;
  budget: number;
  perP4P: number;
  /** N (จำนวนแพทย์): per P4P = budget ÷ N. Null for a round sent before N was asked for. */
  doctors: number | null;
  builtAt: string;
  sk03File: string;
  mergedFile: string;
  depts: PdfDept[];
}

// ─── Formatting ─────────────────────────────────────────────────────────────

/** Escape a value before it goes into the HTML. */
export function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 9620 → "9,620"; 2158709.06 → "2,158,709.06"; text stays text. */
export function money(v: unknown): string {
  if (v === null || v === undefined || String(v).trim() === '') return '';
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
  if (!Number.isFinite(n)) return String(v).trim();
  const x = Math.round(n * 100) / 100;
  const whole = Number.isInteger(x);
  return x.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
}

/** The parts of a moment in Bangkok time. */
function bangkok(iso: string): { d: number; m: number; y: number; hh: string; mm: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return { d: Number(get('day')), m: Number(get('month')), y: Number(get('year')) + 543, hh: get('hour'), mm: get('minute') };
}

/** "9 พฤศจิกายน พ.ศ. 2569 เวลา 10:05 น." or, short, "9 พ.ย. 2569 10:05 น." */
export function thaiDateTime(iso: string, short = false): string {
  const t = bangkok(iso);
  return short
    ? `${t.d} ${TH_MONTHS_SHORT[t.m - 1]} ${t.y} ${t.hh}:${t.mm} น.`
    : `${t.d} ${TH_MONTHS[t.m - 1]} พ.ศ. ${t.y} เวลา ${t.hh}:${t.mm} น.`;
}

/** "2569_10" → "ตุลาคม พ.ศ. 2569" */
export function monthTitle(month: string): string {
  const m = /^(\d{4})_(\d{2})$/.exec(month);
  return m ? `${TH_MONTHS[Number(m[2]) - 1]} พ.ศ. ${m[1]}` : month;
}

const squash = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim();
const deptLabel = (name: string): string => (name === 'INTERN' ? 'อินเทิร์น' : name);

/**
 * Rows per page for one department: at most 13 a page and 8 on the last page
 * (it also carries the รวม row and the signatures), spread evenly.
 * 0 rows still gets one page.
 */
export function paginate(n: number): number[] {
  if (n <= ROWS_LAST_PAGE) return [Math.max(0, n)];
  const pages = 1 + Math.ceil((n - ROWS_LAST_PAGE) / ROWS_PER_PAGE);
  const last = Math.min(ROWS_LAST_PAGE, Math.floor(n / pages));
  const rest = n - last;
  const base = Math.floor(rest / (pages - 1));
  const extra = rest % (pages - 1);
  const out = Array.from({ length: pages - 1 }, (_, i) => base + (i < extra ? 1 : 0));
  out.push(last);
  return out;
}

// ─── HTML ───────────────────────────────────────────────────────────────────

const CHECK_SVG = '<svg class="tick" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function css(fonts: { regular: string; bold: string }): string {
  return `
@font-face { font-family: 'SarabunPSK-PDF'; font-weight: 400; src: url(data:font/ttf;base64,${fonts.regular}) format('truetype'); }
@font-face { font-family: 'SarabunPSK-PDF'; font-weight: 700; src: url(data:font/ttf;base64,${fonts.bold}) format('truetype'); }
@page { size: A4 landscape; margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { font-family: 'SarabunPSK-PDF', sans-serif; color: #111; font-size: 15pt; line-height: 1.35; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.page { position: relative; width: 297mm; height: 209.5mm; overflow: hidden; page-break-after: always; break-after: page; }
.page:last-child { page-break-after: auto; break-after: auto; }
.body { position: absolute; top: 10mm; left: 12mm; right: 12mm; bottom: 24mm; overflow: hidden; }
.body[data-tight="1"] { font-size: 14pt; }
.body[data-tight="2"] { font-size: 13pt; }
.body[data-tight="3"] { font-size: 12pt; }
.body[data-tight="2"] td, .body[data-tight="2"] th, .body[data-tight="3"] td, .body[data-tight="3"] th { padding-top: 1px; padding-bottom: 1px; }
.form { position: absolute; top: 4.5mm; right: 12mm; font-size: 12pt; line-height: 1; white-space: nowrap; }
footer { position: absolute; left: 12mm; right: 12mm; bottom: 10mm; height: 9mm; display: grid; grid-template-columns: 1fr auto 1fr; align-items: end; font-size: 14pt; }
footer .pg { grid-column: 2; padding-bottom: 1mm; }
footer .ok { grid-column: 3; justify-self: end; border-top: 0.35mm solid #111; padding: 1.2mm 0 0 18mm; font-weight: 700; white-space: nowrap; }
h1 { font-size: 1.75em; text-align: center; line-height: 1.3; }
.sub { font-size: 1.3em; font-weight: 700; text-align: center; margin-top: 0.5mm; }
.stamp { display: flex; justify-content: center; margin: 3.5mm auto 4mm; }
.stamp span { display: inline-flex; align-items: center; gap: 2mm; border: 0.5mm solid #111; outline: 0.25mm solid #111; outline-offset: 0.6mm; border-radius: 2mm; padding: 1.2mm 6mm; font-size: 1.3em; font-weight: 700; }
.tick { width: 1em; height: 1em; }
h2 { font-size: 1.12em; margin: 2.5mm 0 1.5mm; }
table { width: 100%; border-collapse: collapse; }
th, td { border: 0.25mm solid #111; padding: 1mm 2mm; vertical-align: middle; }
th { background: #EDEDED; font-weight: 700; text-align: center; }
td.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.c { text-align: center; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; align-items: start; }
.two td { border-left: 0.25mm solid #111; border-right: 0.25mm solid #111; border-bottom: 0.2mm dotted #666; padding: 0.8mm 2mm; }
.two tr.sum td { background: #EDEDED; font-weight: 700; border-bottom: 0.25mm solid #111; }
.info th { text-align: left; width: 21%; }
.info td { width: 29%; }
.head { text-align: center; margin-bottom: 3mm; }
.head .t1 { font-size: 1.4em; font-weight: 700; line-height: 1.3; }
.head .t2 { font-size: 1.2em; font-weight: 700; line-height: 1.3; }
.sheet { table-layout: fixed; }
.sheet th, .sheet td { padding-left: 1.5mm; padding-right: 1.5mm; }
.sheet td.rm { white-space: nowrap; overflow: hidden; }
.sheet td { height: 9.6mm; }
.sheet tr.sum td { background: #EDEDED; font-weight: 700; }
.signs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8mm; margin-top: 13mm; text-align: center; }
.signs .line { border-top: 0.3mm solid #111; margin: 0 8mm 1.5mm; }
.signs p { line-height: 1.5; }
`;
}

function footer(page: number, pages: number, stamp: string): string {
  return `<footer><span class="pg">หน้า ${page} / ${pages}</span><span class="ok">อนุมัติเมื่อ ${esc(stamp)}</span></footer>`;
}

/** The whole document; `pages` is the number of A4 pages it lays out. */
export function buildHtml(d: PdfData, fonts: { regular: string; bold: string }): { html: string; pages: number } {
  const stamp = thaiDateTime(d.approvedAt);
  const layout = d.depts.map((dept) => ({ dept, sizes: paginate(dept.rows.length) }));
  let next = 2;
  const starts = layout.map((l) => { const s = next; next += l.sizes.length; return s; });
  const pages = next - 1;

  const doctors = d.depts.reduce((s, x) => s + x.rows.length, 0);
  const sumOf = (k: 'admin' | 'pay' | 'total'): number => d.depts.reduce((s, x) => s + (Number(x[k]) || 0), 0);
  // Department sheet columns: E งานบริหาร (management stipends, paid on top
  // of the P4P budget), F ตามสัดส่วนวิชาชีพ (the P4P pay), G รวมเป็นเงิน = E + F.
  // The budget (staff Y9) covers F only: the SK03's own คงคืน is Y9 − Y19,
  // Y19 being "P4P staff & intern (ไม่รวมค่าบริหาร)".
  const admin = sumOf('admin');
  const pay = sumOf('pay');
  const total = sumOf('total');
  const half = Math.ceil(layout.length / 2);
  const summaryRow = (i: number): string => {
    const x = layout[i].dept;
    return `<tr><td>${esc(deptLabel(x.name))}</td><td class="n">${x.rows.length.toLocaleString('en-US')}</td>` +
      `<td class="n">${money(x.total)}</td><td class="n">${starts[i]}</td></tr>`;
  };
  const summaryHead = '<thead><tr><th style="width:44%">กลุ่มงาน</th><th style="width:19%">จำนวนแพทย์</th>' +
    '<th style="width:26%">รวมเป็นเงิน (บาท)</th><th style="width:11%">หน้า</th></tr></thead>';
  const left = layout.slice(0, half).map((_, i) => summaryRow(i)).join('');
  const right = layout.slice(half).map((_, i) => summaryRow(half + i)).join('') +
    `<tr class="sum"><td>รวมทั้งสิ้น</td><td class="n">${doctors.toLocaleString('en-US')}</td><td class="n">${money(total)}</td><td></td></tr>`;

  const left_over = Math.round((d.budget - pay) * 100) / 100 || 0;   // || 0: never "-0"
  const balance = left_over < 0 ? `เกินงบ ${money(-left_over)} บาท` : `คงเหลือ ${money(left_over)} บาท`;
  const timeline = [
    `ผู้จัดทำ ${esc(d.submittedBy || '—')} ส่งรอบที่ ${d.roundNo}: ${esc(thaiDateTime(d.submittedAt, true))}`,
    d.reopenedAt ? `ผู้ตรวจสอบ ${esc(d.reopenedBy || '—')} ยกเลิกเอกสารเดิมและเปิดตรวจอีกครั้ง: ${esc(thaiDateTime(d.reopenedAt, true))} (${esc(d.reopenReason)})` : '',
    `ผู้ตรวจสอบ ${esc(d.approvedBy || '—')} อนุมัติครบ: ${esc(thaiDateTime(d.approvedAt, true))}`,
  ].filter(Boolean).join(' · ');

  const cover = `<section class="page"><div class="body">
<h1>เอกสารเบิกจ่ายค่าตอบแทนตามผลการปฏิบัติงาน (P4P) ${HOSPITAL}</h1>
<p class="sub">ประจำเดือน ${esc(monthTitle(d.month))}</p>
<p class="stamp"><span>${CHECK_SVG} ผู้ตรวจสอบอนุมัติครบ ${d.approvedPeople.toLocaleString('en-US')} คน · เมื่อ ${esc(stamp)}</span></p>
<h2>สรุปรายกลุ่มงาน (${layout.length} กลุ่มงาน · แพทย์ ${doctors.toLocaleString('en-US')} คน · รวม ${money(total)} บาท)</h2>
<div class="two"><table>${summaryHead}<tbody>${left}</tbody></table><table>${summaryHead}<tbody>${right}</tbody></table></div>
<h2>ข้อมูลที่ใช้คำนวณและผลการตรวจสอบ</h2>
<table class="info"><tbody>
<tr><th>งบประมาณทั้งหมด</th><td>${money(d.budget)} บาท</td><th>per P4P (อินเทิร์น)</th><td>${money(d.perP4P)} บาท/คน${d.doctors ? ` (งบประมาณ ÷ N ${d.doctors.toLocaleString('en-US')})` : ''}</td></tr>
<tr><th>P4P ที่จ่าย (ไม่รวมค่าบริหาร)</th><td>${money(pay)} บาท (${balance})</td><th>ค่าตอบแทนบริหาร (นอกงบ P4P)</th><td>${money(admin)} บาท</td></tr>
<tr><th>รวมจ่ายตามชีตกลุ่มงาน</th><td>${money(total)} บาท</td><th>ผลการตรวจสอบ</th><td>อนุมัติ ${d.approvedPeople.toLocaleString('en-US')} / ${d.people.toLocaleString('en-US')} คน ใน ${d.rounds} รอบ</td></tr>
<tr><th>ไฟล์ที่ใช้</th><td colspan="3">ผู้จัดทำส่งรอบที่ ${d.roundNo}: ${esc(d.sk03File || 'SK03')} · ${esc(d.mergedFile || 'รวมค่าคะแนน')} (ระบบสร้าง ${esc(thaiDateTime(d.builtAt, true))})</td></tr>
<tr><th>ลำดับเหตุการณ์</th><td colspan="3">${timeline}</td></tr>
</tbody></table>
</div>${footer(1, pages, stamp)}</section>`;

  // Widths fit the longest August 2569 values on one line at 15 pt (Pong,
  // 2026-11-12: หมายเหตุ such as "ผู้ช่วยผู้อำนวยการด้านสุขภาพดิจิทัล" on one line).
  // A longer remark is set smaller by renderPdf until it fits.
  const sheetHead = `<colgroup><col style="width:4.2%"><col style="width:18.7%"><col style="width:15.8%"><col style="width:12.1%">` +
    `<col style="width:6.6%"><col style="width:6.6%"><col style="width:6.6%"><col style="width:10%"><col style="width:19.4%"></colgroup>` +
    `<thead><tr><th rowspan="2">ลำดับ</th><th rowspan="2">ชื่อ-สกุล</th><th rowspan="2">ตำแหน่ง</th><th rowspan="2">ประเภท</th>` +
    `<th colspan="3">ค่าตอบแทนตามผลการปฏิบัติงาน (บาท)</th><th rowspan="2">ลายมือชื่อผู้รับเงิน</th><th rowspan="2">หมายเหตุ</th></tr>` +
    `<tr><th>งาน<br>บริหาร</th><th>ตามสัดส่วน<br>วิชาชีพ</th><th>รวมเป็น<br>เงิน</th></tr></thead>`;
  const signs = ['หัวหน้างาน/กลุ่มงาน/ฝ่าย', 'หัวหน้ากลุ่มภารกิจ', 'ประธานคณะกรรมการตรวจสอบค่าคะแนน'].map((role) =>
    `<div><div class="line"></div><p>( ...................................... )</p><p>${role}</p><p>วันที่ ......../......../........</p></div>`).join('');

  let pageNo = 1;
  const deptPages = layout.map(({ dept, sizes }) => {
    const h = dept.header ?? [];
    const first = (r: number): string => squash((h[r] ?? []).find((c) => squash(c) !== '') ?? '');
    const t1 = first(0) || `หลักฐานการเบิกจ่ายเงินตามค่าตอบแทนผลการปฏิบัติงาน${HOSPITAL}`;
    const t2 = first(1) || `ประจำเดือน ${monthTitle(d.month)}`;
    const t3 = first(2) || `หน่วยงาน ${deptLabel(dept.name)}`;
    let at = 0;
    return sizes.map((size, i) => {
      pageNo++;
      const last = i === sizes.length - 1;
      const rows = dept.rows.slice(at, at + size).map((r) => {
        const c = (k: number): unknown => (r ?? [])[k];
        return `<tr><td class="c">${esc(squash(c(0)))}</td><td>${esc(squash(c(1)))}</td><td>${esc(squash(c(2)))}</td>` +
          `<td>${esc(squash(c(3)))}</td><td class="n">${money(c(4))}</td><td class="n">${money(c(5))}</td>` +
          `<td class="n">${money(c(6))}</td><td>${esc(squash(c(7)))}</td><td class="rm">${esc(squash(c(8)))}</td></tr>`;
      }).join('');
      at += size;
      const sum = last
        ? `<tr class="sum"><td></td><td>รวม ${dept.rows.length.toLocaleString('en-US')} คน</td><td></td><td></td>` +
          `<td class="n">${money(dept.admin)}</td><td class="n">${money(dept.pay)}</td><td class="n">${money(dept.total)}</td><td></td><td></td></tr>`
        : '';
      return `<section class="page"><p class="form">${esc(SK02_FORM)}</p><div class="body">
<div class="head"><p class="t1">${esc(t1)}</p><p class="t2">${esc(t2)}</p><p class="t2">${esc(t3)}</p></div>
<table class="sheet">${sheetHead}<tbody>${rows}${sum}</tbody></table>
${last ? `<div class="signs">${signs}</div>` : ''}
</div>${footer(pageNo, pages, stamp)}</section>`;
    }).join('\n');
  }).join('\n');

  const html = `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>P4P ${esc(d.month)}</title>` +
    `<style>${css(fonts)}</style></head><body>${cover}\n${deptPages}</body></html>`;
  return { html, pages };
}

/** Pages in a PDF Chrome wrote (its page objects are not compressed). */
export function countPdfPages(pdf: Uint8Array): number {
  return (Buffer.from(pdf).toString('latin1').match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
}

// ─── Render ─────────────────────────────────────────────────────────────────

export function loadFonts(): { regular: string; bold: string } {
  const read = (f: string): string => fs.readFileSync(path.join(FONT_DIR, f)).toString('base64');
  return { regular: read('THSarabunPSK-Regular.ttf'), bold: read('THSarabunPSK-Bold.ttf') };
}

/**
 * HTML → PDF. A page whose content does not fit is set a size smaller (up to
 * three times); one that still does not fit fails the job rather than cut a
 * row off.
 */
export async function renderPdf(html: string, pages: number): Promise<Uint8Array> {
  const puppeteer = require('puppeteer') as typeof import('puppeteer');
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate('document.fonts.ready.then(() => true)');
    // หมายเหตุ stays on one line: a remark wider than its column is set
    // smaller, down to 9 pt; past that it wraps rather than being cut off.
    await page.evaluate(`(() => {
      document.querySelectorAll('td.rm').forEach((td) => {
        let pt = parseFloat(getComputedStyle(td).fontSize) * 0.75;
        while (td.scrollWidth > td.clientWidth && pt > 9) { pt -= 0.5; td.style.fontSize = pt + 'pt'; }
        if (td.scrollWidth > td.clientWidth) { td.style.whiteSpace = 'normal'; td.style.fontSize = ''; }
      });
    })()`);
    const tooFull = await page.evaluate(`(() => {
      const out = [];
      document.querySelectorAll('.body').forEach((b, i) => {
        let level = 0;
        while (b.scrollHeight > b.clientHeight + 1 && level < 3) { level++; b.setAttribute('data-tight', String(level)); }
        if (b.scrollHeight > b.clientHeight + 1) out.push(i + 1);
      });
      return out;
    })()`) as number[];
    if (tooFull.length) throw new Error(`content does not fit on page(s) ${tooFull.join(', ')}`);
    const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
    const got = countPdfPages(pdf);
    if (got && got !== pages) throw new Error(`laid out ${pages} pages but the PDF has ${got}`);
    return pdf;
  } finally {
    await browser.close();
  }
}

// ─── The job ────────────────────────────────────────────────────────────────

interface Claim { id: number; month: string; round_no: number; claimed_at: string }

/**
 * Part 3 of the review SQL is not installed: only a definite "not there" code.
 * PGRST002 ("Could not query the database for the schema cache. Retrying."),
 * PGRST000/001, a 5xx or a network error is passing and fails the run like
 * any other error, so the round stays queued and the relay starts 2.8 again.
 */
export const missing = (e: { code?: string | null; message?: string } | null | undefined): boolean =>
  !!e && ['PGRST202', 'PGRST205', '42P01', '42883', '42703'].includes(String(e.code ?? ''));

/** Everything the document shows, for one round. */
export async function loadPdfData(db: SupabaseClient, roundId: number): Promise<PdfData> {
  const one = async <T>(q: PromiseLike<{ data: T | null; error: { message: string } | null }>, what: string): Promise<T> => {
    const { data, error } = await q;
    if (error) throw new Error(`${what}: ${error.message}`);
    if (data === null) throw new Error(`${what}: not found`);
    return data;
  };
  const r = await one(db.from('review_rounds').select('*').eq('id', roundId).maybeSingle(), 'round') as Record<string, any>;
  const b = await one(db.from('review_builds').select('built_at, depts').eq('id', r.build_id).maybeSingle(), 'build') as Record<string, any>;
  // Rounds sent since the second SQL file have no uploads: the build's own files.
  const upIds = [r.sk03_upload, r.merged_upload].filter(Boolean) as string[];
  const ups = upIds.length
    ? await one(db.from('review_uploads').select('id, file_name').in('id', upIds), 'uploads') as { id: string; file_name: string }[]
    : [];
  const decisions = await one(db.from('review_decisions').select('decision').eq('round_id', roundId), 'decisions') as { decision: string | null }[];
  const { count: rounds, error: e5 } = await db.from('review_rounds').select('id', { count: 'exact', head: true }).eq('month', r.month);
  if (e5) throw new Error(`rounds: ${e5.message}`);
  const name = (id: string | null, built: string): string => (id && ups.find((u) => u.id === id)?.file_name) || built;
  return {
    month: r.month, roundNo: r.round_no, rounds: rounds ?? r.round_no,
    approvedAt: r.approved_at, approvedBy: r.approved_by,
    approvedPeople: decisions.filter((x) => x.decision === 'approve').length, people: decisions.length,
    submittedAt: r.submitted_at, submittedBy: r.submitted_by,
    reopenedAt: r.reopened_at ?? null, reopenedBy: r.reopened_by ?? '', reopenReason: r.reopen_reason ?? '',
    budget: Number(r.budget), perP4P: Number(r.per_p4p),
    doctors: r.doctors === null || r.doctors === undefined ? null : Number(r.doctors), builtAt: b.built_at,
    sk03File: name(r.sk03_upload, `SK03_${r.month}.xlsx`), mergedFile: name(r.merged_upload, `merged_${r.month}.xlsx`),
    depts: (b.depts ?? []) as PdfDept[],
  };
}

async function main(): Promise<void> {
  const { createClient } = require('@supabase/supabase-js') as typeof import('@supabase/supabase-js');
  const { log } = require('./lib') as typeof import('./lib');
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_KEY are not set');
  const db = createClient(url, key);
  const fonts = loadFonts();
  let made = 0, failed = 0;
  for (let i = 0; i < MAX_PER_RUN; i++) {
    const { data, error } = await db.rpc('claim_review_pdf');
    if (error) {
      if (missing(error)) { log('Review tables (part 3) not installed — nothing to do.'); return; }
      throw new Error(`claim_review_pdf: ${error.message}`);
    }
    const claim = data as Claim | null;
    if (!claim) break;
    log(`Approval PDF for ${claim.month}, round ${claim.round_no}…`);
    try {
      const pdfData = await loadPdfData(db, claim.id);
      const { html, pages } = buildHtml(pdfData, fonts);
      const pdf = await renderPdf(html, pages);
      const objectPath = `pdf/${claim.month}/round-${claim.round_no}-${Date.now()}.pdf`;
      const { error: upErr } = await db.storage.from(BUCKET).upload(objectPath, Buffer.from(pdf), { contentType: 'application/pdf', upsert: false });
      if (upErr) throw new Error(`storage upload: ${upErr.message}`);
      const { data: ok, error: doneErr } = await db.rpc('review_pdf_done', {
        p_round: claim.id, p_claimed: claim.claimed_at, p_path: objectPath, p_bytes: pdf.length, p_pages: pages,
      });
      if (doneErr || !ok) {
        await db.storage.from(BUCKET).remove([objectPath]);
        if (doneErr) throw new Error(`review_pdf_done: ${doneErr.message}`);
        log(`  ${claim.month}: the month was reopened while the PDF was being made — file dropped.`, 'warn');
        continue;
      }
      made++;
      log(`  ✓ ${claim.month}: ${pages} pages, ${(pdf.length / 1024).toFixed(0)} KB`);
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      log(`  ❌ ${claim.month}: ${msg}`, 'warn');
      await db.rpc('review_pdf_failed', { p_round: claim.id, p_claimed: claim.claimed_at, p_error: msg });
    }
  }
  log(`Done: ${made} made, ${failed} failed.`);
  if (failed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('❌ review-pdf.ts failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
