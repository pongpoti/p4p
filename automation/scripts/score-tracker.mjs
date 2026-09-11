/**
 * scripts/score-tracker.mjs
 *
 * Monthly P4P score-completion tracker.
 * Runs as a job in .github/workflows/process-pipeline.yml, on that
 * workflow's daily schedule (no schedule of its own).
 *
 * Logic (whole-month gate — month is the outer loop):
 *  For each month in a rolling window (floored at CATCHUP_START_MONTH):
 *   (a) Gate — no department head is emailed for a month until the ENTIRE
 *       month is complete: every non-intern person that month has a non-null
 *       score (see isMonthComplete). Interns are excluded and never emailed.
 *       If any non-intern person is still missing, the month sends nothing
 *       and waits for a later run.
 *   (b) Send — once complete, every head gets ONE single-month report for
 *       that month; departments sharing a head email are grouped into one
 *       email. Each email covers exactly one month (no multi-month bundling).
 *       Never resend a (department, month) already logged in email_sent_log.
 *       Two months completing in the same run each send their own
 *       single-month email. In addition, the oversight address gets its OWN
 *       single consolidated email per month — every department sent in that
 *       run, sorted in Thai dictionary order — rather than a Bcc copy of each
 *       head's email (skipped on TEST runs).
 *
 * Required env vars (GitHub Secrets):
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 *   SUPABASE_URL, SUPABASE_KEY
 *
 * Department → head email comes from the Supabase dept_heads table (RLS
 * locked to service_role — see sql/dept_heads.sql), not a GitHub secret:
 * heads change often, and secrets are write-only, so a table you can read
 * and edit a single row of beats re-pasting a whole JSON blob each time.
 */

import "../redact.js";   // MUST be first: patches console before anything logs (public job logs)

import { config as dotenvConfig } from "dotenv";
import { appendFileSync }        from "fs";
import { createGmailClient }     from "../gmail-client.js";
import { createDriveClient }     from "../drive-client.js";
import { buildScoreReportEmail } from "../templates/score-report-email.js";
import { getDeptHeads }          from "../supabase-client.js";
import { bangkokNow, todayThaiStr } from "../bangkok-date.js";
import { createSB, maskEmail, getDeptStatus } from "../dept-status.js";

dotenvConfig({ override: true });

// ── Configuration ─────────────────────────────────────────────────────────
const EXEMPT_DEPTS = new Set(["INTERN"]);
// How far back each run scans for a month that is complete but not yet sent.
// Wide enough that a month which only becomes complete on a later day (its
// slowest department finishing late) is still caught by that day's run.
const CATCHUP_WINDOW_MONTHS = 12;
// Never scan earlier than this month key, even if it's within the window
// above — pre-existing history further back than this predates the
// whole-month-gate cutover and is out of scope. Reports go out per month
// starting from here (May 2026 / พ.ค. 69).
const CATCHUP_START_MONTH = "2569_05";

// Compulsory oversight recipient — gets ONE consolidated email per month
// covering every department sent in that run (not a Bcc copy of each head's
// email), independent of the dept_heads table. This is a hard requirement:
// whenever ANY dept head is emailed on a run, this address must receive a
// report covering that same set of departments too. Skipped only on TEST
// runs (TEST_EMAIL_OVERRIDE set), which redirect the whole send to a test
// address and must stay isolated from real inboxes.
// Read from the environment, never hardcoded: this repository is public, and
// a hardcoded value published a named individual's personal address. Set the
// OVERSIGHT_EMAIL secret in GitHub Actions. Unset -> the oversight copy is
// SKIPPED with a loud warning; the department-head reports still go out,
// because those are the primary function and must not fail over this.
const OVERSIGHT_EMAIL = (process.env.OVERSIGHT_EMAIL ?? "").trim();

// ── Test-mode overrides (manual workflow_dispatch only, see process-pipeline.yml) ──
// Restrict to specific department(s) and/or redirect the email to a test
// address instead of the real dept head — lets you verify a real send
// end-to-end without touching a real department head's inbox. When
// TEST_EMAIL is set, the run never writes to email_sent_log, so it has no
// effect on the next real scheduled run.
const TEST_DEPT_FILTER    = (process.env.TEST_DEPT ?? "").split(",").map(s => s.trim()).filter(Boolean);
const TEST_EMAIL_OVERRIDE = process.env.TEST_EMAIL?.trim() || null;

// ── Thai locale data ───────────────────────────────────────────────────────
const THAI_MONTHS = {
  "01":"มกราคม","02":"กุมภาพันธ์","03":"มีนาคม","04":"เมษายน",
  "05":"พฤษภาคม","06":"มิถุนายน","07":"กรกฎาคม","08":"สิงหาคม",
  "09":"กันยายน","10":"ตุลาคม","11":"พฤศจิกายน","12":"ธันวาคม",
};
const THAI_MONTHS_SHORT = {
  "01":"ม.ค.","02":"ก.พ.","03":"มี.ค.","04":"เม.ย.",
  "05":"พ.ค.","06":"มิ.ย.","07":"ก.ค.","08":"ส.ค.",
  "09":"ก.ย.","10":"ต.ค.","11":"พ.ย.","12":"ธ.ค.",
};

// ── Date helpers ───────────────────────────────────────────────────────────

/** Most-recent-first list of the `count` calendar months before this one. */
function getPreviousMonths(count) {
  // Bangkok-safe: this workflow is cron'd for the 1st of the month, and a
  // raw `new Date()` reads the GitHub Actions runner's UTC clock — right at
  // the Bangkok midnight boundary that resolves to the wrong month.
  const { ceYear, month } = bangkokNow();
  let y = ceYear;
  let m = month;
  const result = [];
  for (let i = 0; i < count; i++) {
    if (--m === 0) { m = 12; y--; }
    result.push(`${y + 543}_${String(m).padStart(2, "0")}`);
  }
  return result; // most-recent first
}

function tableKeyToDisplay(key) {
  const [year, month] = key.split("_");
  return `${THAI_MONTHS[month] ?? month} ${year}`;
}

// Single monthKey → abbreviated label, e.g. "2569_05" → "พ.ค. 69".
function monthShortLabel(key) {
  const [year, month] = key.split("_");
  return `${THAI_MONTHS_SHORT[month] ?? month} ${year.slice(-2)}`;
}

// Thai dictionary order, not raw Unicode order — leading vowels (เ แ โ ใ ไ)
// sort as if placed after the consonant they attach to, e.g.
// "เวชศาสตร์ครอบครัว" sorts under ว, not เ. Used for the oversight email's
// department listing.
const thaiCollator = new Intl.Collator("th");
function sortDeptsThai(list) {
  return [...list].sort((a, b) => thaiCollator.compare(a.dept, b.dept));
}

// todayThaiStr is now imported from ../bangkok-date.js (Bangkok-safe; see
// the comment on getPreviousMonths above for why raw `new Date()` is unsafe
// here). maskEmail/createSB/getDeptStatus are now imported from
// ../dept-status.js (shared with resend-month.mjs).

// ── Completeness gate (pure — covered by test/scoreTrackerCatchup.test.js) ─

/**
 * Whole-month gate: is every submission for this month in?
 *
 * No department head is emailed for a month until the ENTIRE month is
 * complete — every non-intern person that month has a non-null score.
 * Interns are already absent from `deptStatuses` (getDistinctDepts excludes
 * EXEMPT_DEPTS), so they never gate a send.
 *
 * @param {Array<{ complete: boolean }|null>} deptStatuses  one getDeptStatus()
 *        result per non-intern department in the month (null = that department
 *        has no rows this month — not yet created / nobody assigned).
 * @returns {boolean} true iff at least one department has data AND every
 *        department that has data is complete.
 */
export function isMonthComplete(deptStatuses) {
  const present = deptStatuses.filter(s => s !== null);
  if (present.length === 0) return false; // no data at all → nothing to send
  return present.every(s => s.complete);
}

// createSB/getDeptStatus are now imported from ../dept-status.js.

async function getDistinctDepts(sb, tableKeys) {
  const deptSet = new Set();
  for (const key of tableKeys) {
    const { data, error } = await sb.from(key).select("department");
    if (error || !data) continue;
    for (const r of data) {
      if (r.department && !EXEMPT_DEPTS.has(r.department.trim())) deptSet.add(r.department.trim());
    }
  }
  return [...deptSet].sort();
}

// ── Send-log helpers (email_sent_log) ───────────────────────────────────────
// Prevents re-sending a department's report for a month it's already been
// emailed about, and leaves an audit trail of when each report went out.

/** Fetch every (department → Set<monthKey>) already sent within the window. */
async function getSentMonthsByDept(sb, monthKeys) {
  const { data, error } = await sb
    .from("email_sent_log")
    .select("table_name, department")
    .in("table_name", monthKeys);
  if (error) { console.warn(`⚠️  email_sent_log read failed: ${error.message}`); return new Map(); }
  const map = new Map();
  for (const { table_name, department } of data) {
    if (!map.has(department)) map.set(department, new Set());
    map.get(department).add(table_name);
  }
  return map;
}

// Failures collected here are surfaced in the step summary AND fail the run
// (see main()'s final check) — an email that sent successfully but whose
// "sent" log write silently failed would otherwise go unnoticed until the
// NEXT scheduled run resends the same report to the same department head.
const logSentFailures = [];

async function logEmailSent(sb, tableKey, department) {
  const upsertOnce = () => sb
    .from("email_sent_log")
    .upsert(
      { table_name: tableKey, department, sent_at: new Date().toISOString() },
      { onConflict: "table_name,department", ignoreDuplicates: true }
    );

  let { error } = await upsertOnce();
  if (error) {
    console.warn(`⚠️  email_sent_log insert failed [${department}/${tableKey}], retrying once: ${error.message}`);
    ({ error } = await upsertOnce());
  }
  if (error) {
    console.error(`❌  email_sent_log insert failed twice [${department}/${tableKey}]: ${error.message} — the report WAS emailed, but this run will not remember that, risking a duplicate send next time.`);
    logSentFailures.push({ tableKey, department, message: error.message });
  }
}


// ── Main ───────────────────────────────────────────────────────────────────
export async function main() {
  const todayStr = todayThaiStr();

  console.log(`\n${"═".repeat(62)}`);
  console.log(`  P4P Score Tracker  —  ${todayStr}`);
  console.log(`  Whole-month gate: heads are emailed only once every non-intern`);
  console.log(`  submission for a month is in. Window: last ${CATCHUP_WINDOW_MONTHS} months, not before ${tableKeyToDisplay(CATCHUP_START_MONTH)}`);
  console.log(`${"═".repeat(62)}\n`);

  // most-recent first, floored at CATCHUP_START_MONTH so pre-cutover history
  // is out of scope and each month is reported once from May 2026 onward
  const monthsDesc = getPreviousMonths(CATCHUP_WINDOW_MONTHS).filter(key => key >= CATCHUP_START_MONTH);
  const monthsAsc  = [...monthsDesc].reverse();                // oldest first — scan order
  if (!monthsAsc.length) { console.log(`⚠️  No months in range (CATCHUP_START_MONTH ${CATCHUP_START_MONTH} is outside the ${CATCHUP_WINDOW_MONTHS}-month window) — nothing to do.`); return; }
  const sb         = createSB();
  const gmail      = createGmailClient();
  const DEPT_HEADS = await getDeptHeads();

  console.log(`📅  Window: ${tableKeyToDisplay(monthsAsc[0])} → ${tableKeyToDisplay(monthsAsc[monthsAsc.length - 1])}\n`);

  // ── Build Drive file maps (one API call per month, shared across all depts)
  const drive = process.env.P4P_FOLDER_ID ? createDriveClient() : null;
  const driveFileMaps = new Map(); // tableKey → Map<physicianName, fileId>
  if (drive) {
    for (const key of monthsAsc) {
      try {
        const fileMap = await drive.listMonthFiles(key);
        driveFileMaps.set(key, fileMap);
      } catch (e) {
        console.warn(`⚠️  Drive lookup failed for ${key}: ${e.message}`);
      }
    }
    console.log();
  }

  let depts = await getDistinctDepts(sb, monthsDesc);
  if (!depts.length) { console.log("⚠️  No departments found — nothing to do."); return; }

  if (TEST_DEPT_FILTER.length) {
    depts = depts.filter(d => TEST_DEPT_FILTER.includes(d));
    console.log(`🧪  TEST MODE — dept filter: ${TEST_DEPT_FILTER.join(", ")}`);
    if (TEST_EMAIL_OVERRIDE) console.log(`🧪  TEST MODE — recipient override: ${maskEmail(TEST_EMAIL_OVERRIDE)} (email_sent_log will NOT be updated)`);
    if (!depts.length) { console.log("⚠️  No matching department(s) found — nothing to do."); return; }
  }
  console.log(`🏥  Departments: ${depts.join(", ")}\n`);

  const sentByDept = await getSentMonthsByDept(sb, monthsAsc);

  // ── Per-month whole-month gate → send ───────────────────────────────────
  // Month is the OUTER loop. No head is emailed for a month until every
  // non-intern department that month is complete (isMonthComplete). Once it
  // is, every head gets ONE single-month report for that month, logged once
  // per (dept, month) so it never resends; oversight then gets its own single
  // consolidated email covering every department just sent. Each month is
  // independent — two months completing in the same run each send their own
  // single-month emails; no email ever bundles two months.
  const summaryRows = [];

  for (const monthKey of monthsAsc) {
    const monthDisplay = tableKeyToDisplay(monthKey);
    console.log(`┌─ ${monthDisplay}`);

    // (a) Per-dept status — drives both the gate and the email content.
    const statusByDept = new Map();
    for (const dept of depts) {
      const status = await getDeptStatus(sb, monthKey, dept, driveFileMaps.get(monthKey) ?? null);
      statusByDept.set(dept, status);
      const icon = !status ? "—" : status.complete ? "✓" : `✗ ค้าง ${status.missing}/${status.total}`;
      console.log(`│   ${dept}: ${icon}`);
    }

    // (b) Whole-month gate — nothing goes out until the last non-intern
    // person that month has submitted.
    if (!isMonthComplete([...statusByDept.values()])) {
      const pending = [...statusByDept.entries()]
        .filter(([, s]) => s && !s.complete)
        .map(([d, s]) => `${d} (${s.missing}/${s.total})`);
      const note = pending.length
        ? `เดือนยังไม่ครบถ้วน — ยังขาด: ${pending.join(", ")}`
        : "ยังไม่มีข้อมูลในเดือนนี้";
      console.log(`└─ ยังไม่ส่ง — ${note}\n`);
      summaryRows.push({ month: monthDisplay, dept: "—", emailed: false, note });
      continue;
    }

    // (c) Complete → collect depts that have data, skip already-sent, group
    // departments sharing a head email so that head gets ONE email this month.
    const byEmail = new Map();
    for (const [dept, status] of statusByDept) {
      if (status === null) continue; // no rows this month — nothing to report
      if (sentByDept.get(dept)?.has(monthKey)) {
        summaryRows.push({ month: monthDisplay, dept, emailed: false, note: "ส่งแล้ว" });
        continue;
      }
      const email = TEST_EMAIL_OVERRIDE ?? ((DEPT_HEADS[dept] ?? DEPT_HEADS[dept.trim()]) ?? null);
      if (!email) {
        console.log(`│   ⚠️  "${dept}": ไม่มีอีเมลหัวหน้า — ข้ามการส่ง`);
        summaryRows.push({ month: monthDisplay, dept, emailed: false, note: "ไม่มีอีเมลหัวหน้า" });
        continue;
      }
      if (!byEmail.has(email)) byEmail.set(email, []);
      byEmail.get(email).push({ dept, status });
    }

    if (byEmail.size === 0) {
      console.log(`└─ ครบถ้วน — ไม่มีกลุ่มงานใหม่ที่ต้องส่ง\n`);
      continue;
    }

    // (d) Send one email per (head, month).
    console.log(`└─ ครบถ้วน — ส่งอีเมลหัวหน้ากลุ่มงาน`);
    const sentThisMonth = []; // { dept, status } for every dept actually sent — feeds the oversight email
    for (const [email, deptList] of byEmail) {
      const deptNames = deptList.map(d => d.dept).join(", ");

      const introText = `ระบบตรวจสอบและยืนยันว่าการส่งคะแนน P4P ของเดือน ` +
        `${monthDisplay} เสร็จสมบูรณ์ครบถ้วนแล้ว ` +
        `กดชื่อแพทย์เพื่อเปิดไฟล์ Excel บน Google Drive`;

      const html = buildScoreReportEmail({
        depts: deptList.map(d => ({
          dept: d.dept,
          monthsSummary: [{ displayName: monthDisplay, status: d.status }],
        })),
        reportDate: todayStr,
        intro: introText,
      });

      const subjectPrefix = TEST_EMAIL_OVERRIDE ? "[TEST] " : "";
      const subject   = `${subjectPrefix}รายงานคะแนน P4P ของกลุ่มงาน ${deptNames} เดือน ${monthShortLabel(monthKey)} (ครบถ้วน)`;
      const plainBody = `รายงานคะแนน P4P — เดือน ${monthDisplay}\nกลุ่มงาน: ${deptNames}`;

      await gmail.sendMessage({ to: email, subject, body: plainBody, html });
      console.log(`    📧  ${maskEmail(email)} — ${deptNames}`);

      for (const { dept, status } of deptList) {
        if (!TEST_EMAIL_OVERRIDE) await logEmailSent(sb, monthKey, dept);
        summaryRows.push({ month: monthDisplay, dept, emailed: true, note: `ส่งแล้ว${TEST_EMAIL_OVERRIDE ? " [TEST]" : ""}` });
        sentThisMonth.push({ dept, status });
      }
    }

    // Oversight gets its OWN single email per month covering every department
    // just sent, sorted in Thai dictionary order — not a Bcc of each head's
    // email. Skipped on TEST runs (already redirected to the test address).
    if (sentThisMonth.length > 0 && !TEST_EMAIL_OVERRIDE && !OVERSIGHT_EMAIL) {
      console.warn("    ⚠️   OVERSIGHT_EMAIL is not set — skipping the all-departments summary copy.");
      summaryRows.push({ month: monthDisplay, dept: "(สรุปทุกกลุ่มงาน)", emailed: false, note: "ข้ามไป — ไม่ได้ตั้งค่า OVERSIGHT_EMAIL" });
    }

    if (sentThisMonth.length > 0 && !TEST_EMAIL_OVERRIDE && OVERSIGHT_EMAIL) {
      const sortedDepts = sortDeptsThai(sentThisMonth);
      const introText = `สรุปรายงานคะแนน P4P ของทุกกลุ่มงานที่ครบถ้วนแล้ว ประจำเดือน ` +
        `${monthDisplay} กดชื่อแพทย์เพื่อเปิดไฟล์ Excel บน Google Drive`;

      const html = buildScoreReportEmail({
        depts: sortedDepts.map(d => ({
          dept: d.dept,
          monthsSummary: [{ displayName: monthDisplay, status: d.status }],
        })),
        reportDate: todayStr,
        intro: introText,
      });

      const subject   = `สรุปรายงานคะแนน P4P ทุกกลุ่มงาน เดือน ${monthShortLabel(monthKey)} (ครบถ้วน)`;
      const plainBody = `สรุปรายงานคะแนน P4P — เดือน ${monthDisplay}\nกลุ่มงาน: ${sortedDepts.map(d => d.dept).join(", ")}`;

      await gmail.sendMessage({ to: OVERSIGHT_EMAIL, subject, body: plainBody, html });
      console.log(`    📧  ${maskEmail(OVERSIGHT_EMAIL)} — สรุปทุกกลุ่มงาน (${sortedDepts.length} กลุ่มงาน)`);
      summaryRows.push({ month: monthDisplay, dept: "(สรุปทุกกลุ่มงาน)", emailed: true, note: `ส่งแล้ว — ${maskEmail(OVERSIGHT_EMAIL)}` });
    }
    console.log();
  }

  writeSummary(summaryRows, monthsAsc, todayStr);

  if (logSentFailures.length > 0) {
    // Fail the run loudly (non-zero exit → red in GitHub Actions) instead of
    // letting a swallowed email_sent_log write pass as a green run — the
    // report already went out, but without this the next scheduled run has
    // no way to know that and will resend it.
    throw new Error(
      `${logSentFailures.length} email_sent_log write(s) failed after retry — ` +
      logSentFailures.map(f => `${f.department}/${f.tableKey} (${f.message})`).join("; ")
    );
  }
}

// ── Step summary helper ────────────────────────────────────────────────────
function writeSummary(rows, monthsAsc, todayStr) {
  let md = `# 📈 P4P Score Tracker\n\n`;
  md += `**วันที่:** ${todayStr}  \n`;
  md += `**ช่วงที่ตรวจสอบ:** ${tableKeyToDisplay(monthsAsc[0])} – ${tableKeyToDisplay(monthsAsc[monthsAsc.length - 1])}\n\n`;

  if (!rows.length) {
    md += "_ไม่พบกลุ่มงานในช่วงนี้_\n";
  } else {
    md += `| เดือน | กลุ่มงาน | ส่งอีเมล | หมายเหตุ |\n`;
    md += `|---|---|:---:|---|\n`;
    for (const r of rows) {
      md += `| ${r.month ?? "—"} | ${r.dept} | ${r.emailed ? "✅" : "—"} | ${r.note} |\n`;
    }
  }

  if (logSentFailures.length > 0) {
    md += `\n## ⚠️ email_sent_log write failures\n\n`;
    md += `These reports were emailed successfully, but recording that fact failed twice — `;
    md += `they may be resent next run unless fixed manually:\n\n`;
    md += `| Department | Month | Error |\n|---|---|---|\n`;
    for (const f of logSentFailures) {
      md += `| ${f.department} | ${f.tableKey} | ${f.message.replace(/\|/g, "╎")} |\n`;
    }
  }

  md += `\n---\n_Run at ${new Date().toISOString()}_\n`;

  const path = process.env.GITHUB_STEP_SUMMARY;
  if (path) { appendFileSync(path, md, "utf8"); console.log("\n📊 Step summary written"); }
  else       { console.log("\n" + md); }
}

// Only run when invoked directly (so tests can import isMonthComplete etc.)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error("\n❌ Fatal:", err.message);
    process.exit(1);
  });
}
