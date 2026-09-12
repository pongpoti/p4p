/**
 * scripts/send-test-email.mjs
 *
 * Standalone sanity check for Gmail delivery + the score-report email
 * template. Sends a single email with mock data — does NOT touch
 * Supabase, Drive, or DEPT_HEADS_JSON, so it's safe to run without any
 * risk of emailing a real department head.
 *
 * Usage (from automation/):
 *   node scripts/send-test-email.mjs
 *   TEST_EMAIL=someone@else.com node scripts/send-test-email.mjs
 *
 * Environment variables:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 *   TEST_EMAIL   (default: sakhonmso@gmail.com)
 */

import { config as dotenvConfig } from "dotenv";
import { createGmailClient }     from "../gmail-client.js";
import { buildScoreReportEmail } from "../templates/score-report-email.js";
import { todayThaiStr }          from "../bangkok-date.js";

dotenvConfig({ override: true });

const TEST_EMAIL = process.env.TEST_EMAIL ?? "sakhonmso@gmail.com";
// todayThaiStr is Bangkok-safe (see automation/bangkok-date.js) — a raw
// `new Date()` reads the host's local time, which is UTC in CI.

async function main() {
  console.log(`\n${"═".repeat(60)}`);
  console.log("  Send test email (mock data — no Supabase/Drive)");
  console.log(`${"═".repeat(60)}\n`);

  const mockDept = {
    dept: "ทดสอบระบบ (Test)",
    monthsSummary: [
      {
        displayName: "มิถุนายน 2569",
        status: {
          total: 3, filled: 2, missing: 1, complete: false,
          missingNames: ["นพ. ทดสอบ สาม"],
          rows: [
            { name: "นพ. ทดสอบ หนึ่ง", score: 95, driveFileId: null },
            { name: "นพ. ทดสอบ สอง", score: 80, driveFileId: null },
            { name: "นพ. ทดสอบ สาม", score: null, driveFileId: null },
          ],
        },
      },
      {
        displayName: "พฤษภาคม 2569",
        status: { total: 3, filled: 3, missing: 0, complete: true,
          missingNames: [],
          rows: [
            { name: "นพ. ทดสอบ หนึ่ง", score: 90, driveFileId: null },
            { name: "นพ. ทดสอบ สอง", score: 88, driveFileId: null },
            { name: "นพ. ทดสอบ สาม", score: 70, driveFileId: null },
          ],
        },
      },
      { displayName: "เมษายน 2569", status: null },
    ],
  };

  const reportDate = todayThaiStr();
  const html = buildScoreReportEmail({ depts: [mockDept], reportDate });

  const gmail = createGmailClient();
  await gmail.sendMessage({
    to: TEST_EMAIL,
    subject: `[TEST] รายงานสถานะ P4P ทดสอบระบบ — ${reportDate}`,
    body: "อีเมลทดสอบระบบ P4P — ไม่มีข้อมูลจริง",
    html,
  });

  console.log(`✅  Test email sent to ${TEST_EMAIL}`);
}

main().catch((err) => {
  console.error("\n❌ Fatal:", err.message);
  process.exit(1);
});
