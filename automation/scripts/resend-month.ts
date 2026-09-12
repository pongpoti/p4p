/**
 * scripts/resend-month.mjs
 *
 * ONE-OFF resend: physicians submitted missing scores after a month rolled
 * out of the normal 3-month tracker window, so score-tracker.mjs's regular
 * monthly email no longer surfaces the updated status. This reports on the
 * exact month(s) given and resends to every configured department head,
 * regardless of that department's completeness for those months (unlike
 * score-tracker.mjs, this isn't filtered to only newly-complete departments).
 *
 * Usage (from automation/):
 *   TARGET_MONTHS=2569_01,2569_02,2569_03 node scripts/resend-month.mjs
 *   TARGET_MONTH=2569_03 node scripts/resend-month.mjs   # single month, legacy env name
 *
 * Optional overrides (same convention as score-tracker.mjs's workflow_dispatch inputs):
 *   TEST_DEPT   comma-separated department filter; blank = every department found
 *   TEST_EMAIL  send to this address instead of the real dept head(s)
 *
 * Required env vars (same as score-tracker.mjs):
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 *   SUPABASE_URL, SUPABASE_KEY
 *   P4P_FOLDER_ID (optional — enables Drive file links)
 *
 * Department → head email comes from the Supabase dept_heads table (see
 * sql/dept_heads.sql), same as score-tracker.mjs.
 */

import { config as dotenvConfig } from "dotenv";
import { appendFileSync }        from "fs";
import type { SupabaseClient }   from "@supabase/supabase-js";
import { createGmailClient }     from "../gmail-client.js";
import { createDriveClient }     from "../drive-client.js";
import { buildScoreReportEmail } from "../templates/score-report-email.js";
import { getDeptHeads }          from "../supabase-client.js";
import { todayThaiStr }          from "../bangkok-date.js";
import { createSB, maskEmail, getDeptStatus } from "../dept-status.js";
import type { MonthSummary } from "../types.js";

dotenvConfig({ override: true });

const TARGET_MONTHS = (process.env.TARGET_MONTHS ?? process.env.TARGET_MONTH ?? "2569_03")
  .split(",").map(s => s.trim()).filter(Boolean);
const EXEMPT_DEPTS = new Set(["INTERN"]);

const DEPT_FILTER     = (process.env.TEST_DEPT ?? "").split(",").map(s => s.trim()).filter(Boolean);
const TEST_EMAIL_OVERRIDE = process.env.TEST_EMAIL?.trim() || null;

const THAI_MONTHS: Record<string, string> = {
  "01":"มกราคม","02":"กุมภาพันธ์","03":"มีนาคม","04":"เมษายน",
  "05":"พฤษภาคม","06":"มิถุนายน","07":"กรกฎาคม","08":"สิงหาคม",
  "09":"กันยายน","10":"ตุลาคม","11":"พฤศจิกายน","12":"ธันวาคม",
};
const THAI_MONTHS_SHORT: Record<string, string> = {
  "01":"ม.ค.","02":"ก.พ.","03":"มี.ค.","04":"เม.ย.",
  "05":"พ.ค.","06":"มิ.ย.","07":"ก.ค.","08":"ส.ค.",
  "09":"ก.ย.","10":"ต.ค.","11":"พ.ย.","12":"ธ.ค.",
};

function tableKeyToDisplay(key: string): string {
  const [year, month] = key.split("_");
  return `${THAI_MONTHS[month ?? ""] ?? month} ${year}`;
}

// monthKeys (any order) → abbreviated range, oldest to newest, e.g. "ม.ค. - มี.ค. 69"
function monthRangeShortLabel(monthKeys: string[]): string {
  const sorted = [...monthKeys].sort();
  const oldest = sorted[0]!;
  const newest = sorted[sorted.length - 1]!;
  const [oldYear, oldMonth] = oldest.split("_");
  const [newYear, newMonth] = newest.split("_");
  const oldLabel = THAI_MONTHS_SHORT[oldMonth ?? ""] ?? oldMonth;
  const newLabel = THAI_MONTHS_SHORT[newMonth ?? ""] ?? newMonth;
  const oldYY = (oldYear ?? "").slice(-2);
  const newYY = (newYear ?? "").slice(-2);
  return oldYear === newYear
    ? (oldest === newest ? `${oldLabel} ${oldYY}` : `${oldLabel} - ${newLabel} ${newYY}`)
    : `${oldLabel} ${oldYY} - ${newLabel} ${newYY}`;
}

// todayThaiStr, createSB, maskEmail, getDeptStatus are shared with
// score-tracker.mjs — see ../bangkok-date.js and ../dept-status.js. This
// picks up the "table doesn't exist" tolerance getDeptStatus already had in
// score-tracker.mjs's copy but this file's copy was missing, which used to
// make this script crash (instead of reporting "no data") against a month
// whose Supabase table doesn't exist.

async function getDistinctDepts(sb: SupabaseClient, tableKeys: string[]): Promise<string[]> {
  const deptSet = new Set<string>();
  for (const tableKey of tableKeys) {
    const { data, error } = await sb.from(tableKey).select("department");
    if (error || !data) continue;
    for (const r of data as { department: string | null }[]) {
      if (r.department && !EXEMPT_DEPTS.has(r.department.trim())) deptSet.add(r.department.trim());
    }
  }
  return [...deptSet].sort();
}

async function main() {
  const todayStr = todayThaiStr();
  const monthsDisplay = TARGET_MONTHS.map(tableKeyToDisplay).join(", ");

  console.log(`\n${"═".repeat(62)}`);
  console.log(`  P4P Score Tracker — ONE-OFF RESEND — ${monthsDisplay}`);
  console.log(`  (Exclusively ${TARGET_MONTHS.join(", ")} — not the usual 3-month window)`);
  console.log(`${"═".repeat(62)}\n`);

  const sb         = createSB();
  const gmail      = createGmailClient();
  const DEPT_HEADS = await getDeptHeads();

  const drive = process.env.P4P_FOLDER_ID ? createDriveClient() : null;
  const driveFileMaps = new Map<string, Map<string, string>>(); // tableKey → Map<physicianName, fileId>
  if (drive) {
    for (const key of TARGET_MONTHS) {
      try {
        const fileMap = await drive.listMonthFiles(key);
        driveFileMaps.set(key, fileMap);
        console.log(`📁  Drive ${tableKeyToDisplay(key)}: ${fileMap.size} files`);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.warn(`⚠️  Drive lookup failed for ${key}: ${message}`);
      }
    }
    console.log();
  }

  let depts = await getDistinctDepts(sb, TARGET_MONTHS);
  if (!depts.length) { console.log(`⚠️  No departments found for ${TARGET_MONTHS.join(", ")} — nothing to do.`); return; }

  if (DEPT_FILTER.length) {
    depts = depts.filter(d => DEPT_FILTER.includes(d));
    console.log(`🧪  Dept filter: ${DEPT_FILTER.join(", ")}`);
    if (!depts.length) { console.log("⚠️  No matching department(s) found — nothing to do."); return; }
  }
  if (TEST_EMAIL_OVERRIDE) console.log(`🧪  Recipient override: ${maskEmail(TEST_EMAIL_OVERRIDE)}`);
  console.log(`🏥  Departments: ${depts.join(", ")}\n`);

  interface MonthEntry extends MonthSummary {
    key: string;
  }

  // ── Gather per-dept status for every target month ───────────────────────
  const deptData = new Map<string, MonthEntry[]>(); // dept → [{ key, displayName, status }] across all target months
  for (const dept of depts) {
    console.log(`┌─ ${dept}`);
    const monthsSummary: MonthEntry[] = [];
    for (const key of TARGET_MONTHS) {
      const status = await getDeptStatus(sb, key, dept, driveFileMaps.get(key) ?? null);
      const icon = !status ? "—" : status.complete ? "✓" : `✗ ค้าง ${status.missing}/${status.total}`;
      console.log(`│   ${tableKeyToDisplay(key)}: ${icon}`);
      monthsSummary.push({ key, displayName: tableKeyToDisplay(key), status });
    }
    deptData.set(dept, monthsSummary);
  }
  console.log();

  interface DeptEmailEntry {
    dept: string;
    monthsData: MonthEntry[];
  }

  // ── Group departments by head email (same batching as score-tracker.mjs,
  //    but every department is included — not just incomplete ones) ────────
  const byEmail = new Map<string, DeptEmailEntry[]>();
  const noEmail: string[] = [];
  for (const [dept, monthsData] of deptData) {
    const email = TEST_EMAIL_OVERRIDE ?? ((DEPT_HEADS[dept] ?? DEPT_HEADS[dept.trim()]) ?? null);
    if (!email) { noEmail.push(dept); continue; }
    if (!byEmail.has(email)) byEmail.set(email, []);
    byEmail.get(email)!.push({ dept, monthsData });
  }

  const introText = `ระบบได้รวบรวมสถานะการส่งคะแนน P4P ของเดือน ${monthsDisplay} ` +
    `กดชื่อแพทย์เพื่อเปิดไฟล์ Excel บน Google Drive`;

  interface SummaryRow {
    dept: string;
    emailed: boolean;
    note: string;
  }

  const summaryRows: SummaryRow[] = [];
  for (const [email, deptList] of byEmail) {
    const deptNames = deptList.map(d => d.dept).join(", ");
    const monthLabel = monthRangeShortLabel(TARGET_MONTHS);
    console.log(`\n📧  ${maskEmail(email)}`);
    console.log(`    กลุ่มงาน: ${deptNames}`);

    const html = buildScoreReportEmail({
      depts: deptList.map(d => ({ dept: d.dept, monthsSummary: d.monthsData })),
      reportDate: todayStr,
      intro: introText,
    });

    const subjectPrefix = TEST_EMAIL_OVERRIDE ? "[TEST] " : "";
    const subject   = `${subjectPrefix}รายงานคะแนน P4P ของกลุ่มงาน ${deptNames} ประจำเดือน ${monthLabel}`;
    const plainBody = `รายงานคะแนน P4P ประจำเดือน ${monthsDisplay}\nกลุ่มงาน: ${deptNames}`;

    await gmail.sendMessage({ to: email, subject, body: plainBody, html });
    console.log(`    ✉️  ส่งแล้ว`);

    for (const { dept } of deptList) summaryRows.push({ dept, emailed: true, note: `ส่งแล้ว${TEST_EMAIL_OVERRIDE ? " [TEST]" : ""}` });
  }
  for (const dept of noEmail) summaryRows.push({ dept, emailed: false, note: "ไม่มีอีเมลหัวหน้า" });

  writeSummary(summaryRows, monthsDisplay, todayStr);
}

function writeSummary(rows: { dept: string; emailed: boolean; note: string }[], monthsDisplay: string, todayStr: string): void {
  let md = `# 📈 P4P Score Tracker — One-off resend\n\n`;
  md += `**วันที่ส่ง:** ${todayStr}  \n`;
  md += `**เดือนที่ตรวจสอบ (เฉพาะ):** ${monthsDisplay}\n\n`;

  if (!rows.length) {
    md += "_ไม่พบกลุ่มงานในเดือนนี้_\n";
  } else {
    md += `| กลุ่มงาน | ส่งอีเมล | หมายเหตุ |\n`;
    md += `|---|:---:|---|\n`;
    for (const r of rows) md += `| ${r.dept} | ${r.emailed ? "✅" : "—"} | ${r.note} |\n`;
  }

  md += `\n---\n_Run at ${new Date().toISOString()}_\n`;

  const path = process.env.GITHUB_STEP_SUMMARY;
  if (path) { appendFileSync(path, md, "utf8"); console.log("\n📊 Step summary written"); }
  else       { console.log("\n" + md); }
}

main().catch((err: unknown) => {
  console.error("\n❌ Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
