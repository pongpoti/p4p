/**
 * scripts/blank-copies.ts
 *
 * For verify-drive-vs-email: corrections a physician made on a Drive copy
 * that opened blank and emailed back (no text, no formatting), and the
 * copies restore-from-email has already refilled from them.
 */

import { readFileSync } from "fs";
import { compareWithOriginal } from "../xlsx-compare.js";
import { readTabs } from "../xlsx-cells.js";
import { keepOneSheet } from "../xlsx-package.js";
import { hasNoText, refillValues } from "../xlsx-refill.js";
import { pickRestoreTab } from "../restore-pick.js";

/** An indexed email attachment: saved to `file`, sent at `date` (ms) by `from`. */
export interface Original { file: string; date: number; messageId: string; from: string }

/**
 * For a copy with no text at all — a physician corrected numbers on a Drive
 * copy that opened blank and sent it back — the same sender's latest earlier
 * file whose tab says this month and shares at least half its cells: the
 * formatted file to refill (restore-from-email.ts, "+").
 */
export async function earlierFormatted(copy: Buffer, sent: Original, monthKey: string, originals: Iterable<Original>): Promise<Original | null> {
  const copyTab = (await readTabs(copy))[0];
  if (!copyTab || !sent.from) return null;
  const [beYear, month] = monthKey.split("_").map(Number);
  let best: { o: Original; agreement: number } | null = null;
  for (const o of originals) {
    if (o.from !== sent.from || o.date >= sent.date) continue;
    const buf = readFileSync(o.file);
    if (await hasNoText(buf).catch(() => true)) continue;
    const pick = await pickRestoreTab(copyTab, [buf], month!, beYear!).catch(() => null);
    if (!pick?.best.says || pick.closest.agreement < 0.5) continue;
    if (!best || o.date > best.o.date) best = { o, agreement: pick.closest.agreement };
  }
  return best?.o ?? null;
}

/**
 * Whether a copy no attachment holds is a blank-copy correction already
 * refilled: some blank attachment's values are all in it, and rebuilding
 * from that attachment and its sender's earlier file gives this copy.
 */
export async function refilledCopy(copy: Buffer, monthKey: string, blank: Original[], originals: Original[]): Promise<boolean> {
  const copyTab = (await readTabs(copy))[0];
  if (!copyTab || !blank.length) return false;
  const [beYear, month] = monthKey.split("_").map(Number);
  for (const b of blank) {
    const pick = await pickRestoreTab(copyTab, [readFileSync(b.file)], month!, beYear!).catch(() => null);
    if (!pick || pick.closest.agreement < 1) continue;
    const values  = await keepOneSheet(pick.closest.original, pick.closest.keepPos);
    const earlier = values && (await earlierFormatted(values, b, monthKey, originals));
    if (!values || !earlier) continue;
    const e = await pickRestoreTab((await readTabs(values))[0]!, [readFileSync(earlier.file)], month!, beYear!);
    const styled = e && (await keepOneSheet(e.best.original, e.best.keepPos));
    const refill = styled && (await refillValues(styled, values));
    if (refill && (refill.buffer.equals(copy) || (await compareWithOriginal(copy, refill.buffer)).status !== "differs")) return true;
  }
  return false;
}
