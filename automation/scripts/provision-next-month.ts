/**
 * provision-next-month.mjs
 *
 * Creates the current month's roster table (YYYY_MM, Buddhist year) by copying
 * last month's structure + physician roster, resetting score/submitted_at, and
 * applying the standard anon-read RLS. Intended to run from GitHub Actions at
 * 01:00 Asia/Bangkok on the 1st of every month.
 *
 * DDL can't go through PostgREST, so the actual work lives in the Postgres
 * function public.provision_month(p_new, p_old) — see
 * scripts/provision-month-function.sql (install once). This script just
 * computes the two month keys and calls it via RPC with the service_role key.
 *
 * Env:
 *   SUPABASE_URL, SUPABASE_KEY   — required; SUPABASE_KEY MUST be the
 *                                  service_role key (only it may EXECUTE the
 *                                  function).
 *   NEW_KEY, OLD_KEY             — optional manual overrides (e.g. backfill);
 *                                  when set, they bypass the date computation.
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID — optional; a notification is sent
 *                                  when present (best-effort, never fatal).
 *
 * Usage:
 *   node scripts/provision-next-month.mjs
 *   NEW_KEY=2569_08 OLD_KEY=2569_07 node scripts/provision-next-month.mjs
 */

import { createClient } from "@supabase/supabase-js";
import { bangkokYearMonth, monthKey, type BangkokYearMonth } from "../bangkok-date.js";

// ── Month-key math (Buddhist year = CE + 543) ───────────────────────────────
// bangkokYearMonth/monthKey now live in automation/bangkok-date.js (shared
// with score-tracker.mjs / resend-month.mjs / send-test-email.mjs) — re-
// exported here so existing imports (e.g. test/computeMonthKeys.test.js)
// keep working unchanged.
export { bangkokYearMonth, monthKey };

/**
 * Given the current CE year + month (1–12), return the key of that month (new)
 * and of the previous month (old). Handles the Jan→Dec rollover, which crosses
 * both the CE and BE year boundary.
 * @returns {{ newKey: string, oldKey: string }}
 */
export function computeMonthKeys({ ceYear, month }: BangkokYearMonth): { newKey: string; oldKey: string } {
  const newKey = monthKey(ceYear, month);
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? ceYear - 1 : ceYear;
  const oldKey = monthKey(prevYear, prevMonth);
  return { newKey, oldKey };
}

// ── Main (skipped when imported for tests) ──────────────────────────────────

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_KEY");
  }

  const newKey = process.env.NEW_KEY || null;
  const oldKey = process.env.OLD_KEY || null;
  const { newKey: computedNew, oldKey: computedOld } = computeMonthKeys(bangkokYearMonth());
  const p_new = newKey ?? computedNew;
  const p_old = oldKey ?? computedOld;

  console.log(`📅  Provisioning public."${p_new}" from public."${p_old}"` +
    (newKey || oldKey ? "  (manual override)" : ""));

  const supabase = createClient(url, key);
  const { data, error } = await supabase.rpc("provision_month", { p_new, p_old });

  if (error) {
    let hint = "";
    if (/permission denied|not allowed|must be owner/i.test(error.message)) {
      hint = "\n   → SUPABASE_KEY must be the service_role key (only it may EXECUTE provision_month).";
    } else if (/could not find|does not exist|schema cache/i.test(error.message)) {
      hint = "\n   → Install the function first: run scripts/provision-month-function.sql in the SQL editor.";
    }
    throw new Error(`provision_month RPC failed: ${error.message}${hint}`);
  }

  console.log(`✅  ${data}`);
  return String(data);
}

/** Best-effort Telegram notification — never turns a success into a failure. */
async function notify(text: string) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;
  try {
    const { sendTelegram } = await import("../telegram.js");
    await sendTelegram(text);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`⚠️  Telegram notify failed: ${message}`);
  }
}

// Only run when invoked directly (so tests can import the pure functions).
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(async (summary) => {
      await notify(`🗓️ P4P monthly provision\n\n${summary}`);
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(`❌  ${err.message}`);
      await notify(`❌ P4P monthly provision FAILED\n\n${err.message}`);
      process.exit(1);
    });
}
