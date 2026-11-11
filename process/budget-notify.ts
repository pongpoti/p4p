/**
 * budget-notify.ts
 *
 * Pong, 2026-11-11: once workflow 2.2 has built a month's SK03 with the
 * budget and N saved on the dashboard's overview page, Pong gets a Telegram
 * in the admin chat. A save sets review_inputs.tg_pending
 * (scripts/budget-inputs-2026-11.sql PART 2, budget_save); the first build
 * that carries those numbers sends the message and clears it, so a nightly
 * rebuild with unchanged numbers sends nothing.
 *
 * A save made while this build was running (other numbers than the ones it
 * read) stays pending for the build it queued. Never throws: the SK03 is
 * built either way, and the 1.2 watcher already reports a failed run.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

const THAI_MONTHS = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
];

const money = (n: number): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
const rate = (n: number): string => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "กันยายน 2569" for 2569_09. */
export function monthName(monthKey: string): string {
  const m = /^(\d{4})_(\d{2})$/.exec(monthKey);
  const i = m ? parseInt(m[2], 10) - 1 : -1;
  return m && i >= 0 && i < 12 ? `${THAI_MONTHS[i]} ${m[1]}` : monthKey;
}

/** The Telegram text: plain, no parse_mode (Thai needs no escaping then). */
export function formatBudgetBuilt(
  monthKey: string,
  row: { budget: number; per_p4p: number; doctors: number | null },
  ssId: string,
): string {
  return [
    `✅ SK03 ${monthName(monthKey)} สร้างเสร็จแล้ว`,
    `งบ ${money(row.budget)} · N ${row.doctors ?? '–'} · per P4P ${rate(row.per_p4p)}`,
    `https://docs.google.com/spreadsheets/d/${ssId}`,
  ].join('\n');
}

async function sendTelegram(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log('  [Telegram] ℹ TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — budget message skipped');
    return false;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4096) }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
    if (!json?.ok) {
      console.warn(`  [Telegram] ⚠ not sent: ${json?.description ?? `HTTP ${res.status}`}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`  [Telegram] ⚠ not sent: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * After the month's SK03 was built with `used` (budget, per P4P): send the
 * Telegram if a save is waiting for it, then clear the flag. Never throws.
 */
export async function notifyBudgetBuilt(
  supabase: SupabaseClient,
  monthKey: string,
  used: { budget: number; per_p4p: number } | null,
  ssId: string,
): Promise<boolean> {
  if (!used || !ssId) return false;
  try {
    const { data, error } = await supabase.from('review_inputs')
      .select('budget, per_p4p, doctors, tg_pending').eq('month', monthKey).maybeSingle();
    if (error) {
      // PART 2 not run yet (no tg_pending column): nothing to report.
      console.log(`  [Telegram] ℹ budget message skipped (${error.code ?? ''} ${error.message})`);
      return false;
    }
    if (!data || !data.tg_pending) return false;
    const row = { budget: Number(data.budget), per_p4p: Number(data.per_p4p), doctors: data.doctors == null ? null : Number(data.doctors) };
    const cents = (n: number): number => Math.round(n * 100);
    // Saved again since this build read them: the next build reports.
    if (cents(row.budget) !== cents(used.budget) || cents(row.per_p4p) !== cents(used.per_p4p)) return false;
    if (!(await sendTelegram(formatBudgetBuilt(monthKey, row, ssId)))) return false;
    const { error: clearErr } = await supabase.from('review_inputs').update({ tg_pending: false })
      .eq('month', monthKey).eq('budget', data.budget).eq('per_p4p', data.per_p4p);
    if (clearErr) console.warn(`  [Telegram] ⚠ sent, but tg_pending not cleared: ${clearErr.message}`);
    console.log(`  [Telegram] ✓ told Pong the ${monthKey} SK03 is built`);
    return true;
  } catch (err) {
    console.warn(`  [Telegram] ⚠ ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
