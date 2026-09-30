/**
 * restore-pick.ts
 *
 * Which tab of an emailed message to restore over an archived Drive copy.
 * Kept apart from scripts/restore-from-email.ts so the choice can be tested
 * without Drive or Gmail.
 */

import { monthSheet } from "./index.js";
import { readTabs, reproduced, type TabCells } from "./xlsx-cells.js";
import { workbookSheetNames } from "./xlsx-package.js";

export interface TabPick {
  original : Buffer;    // the attachment the tab belongs to
  keepPos  : number;    // the tab's position in that workbook
  tabs     : number;    // how many tabs that workbook has
  agreement: number;    // share of the tab's values the copy holds (reproduced)
  says     : boolean;   // its name or title rows say the copy's month
  isMonth  : boolean;   // the tab the pipeline reads for the copy's month
}

/**
 * The tab most like the copy (`closest`), and the one to restore (`best`):
 * the closest itself when it says the month; otherwise the month's tab of
 * the SAME workbook — a message can carry several physicians' files, and
 * another one's month tab may resemble the copy more than this one's does;
 * the closest again when that workbook has no tab for the month.
 */
export async function pickRestoreTab(copyTab: TabCells, originals: Buffer[], month: number, year: number): Promise<{ closest: TabPick; best: TabPick } | null> {
  const picks: TabPick[] = [];
  for (const original of originals) {
    const names = await workbookSheetNames(original).catch(() => null);
    if (!names) continue;
    const target = await monthSheet(original, month, year).catch(() => null);
    for (const [i, tab] of (await readTabs(original)).entries()) {
      picks.push({
        original,
        keepPos  : names.indexOf(tab.name) >= 0 ? names.indexOf(tab.name) : i,
        tabs     : names.length,
        agreement: reproduced(copyTab, tab),
        says     : target?.says.includes(tab.name) ?? false,
        isMonth  : !!target?.matched && tab.name === target.name,
      });
    }
  }
  const most = (ps: TabPick[]): TabPick | null => ps.reduce<TabPick | null>((a, p) => (!a || p.agreement > a.agreement ? p : a), null);
  const closest = most(picks);
  if (!closest) return null;
  if (closest.says) return { closest, best: closest };
  const forMonth = most(picks.filter((p) => p.original === closest.original && p.isMonth));
  return { closest, best: forMonth ?? closest };
}
