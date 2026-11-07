/**
 * Monthly budget inputs for the SK03 sheet: the month's total budget goes to
 * the staff sheet's งบทั้งหมด (W9) and perP4P to the intern sheet's perP4P (U9).
 *
 * The numbers are kept in ./sk03-budget-inputs.json, copied by hand from
 * pongpoti/p4p-analysis docs/formula/formula.md ("Monthly Budget Inputs") or
 * sent by the P4P admin. That repo is private, so the nightly run does not
 * read it; add a month here when its numbers are known:
 *
 *   "2569_06": { "budget": 2159731.84, "perP4P": 9641.66 }
 *
 * A month not in the file leaves both cells at 0, so its pay shows 0, and the
 * run logs a warning. The 2.2 workflow rebuilds the sheet every night, so a
 * number typed into the Google Sheet itself is lost on the next run.
 */

export interface BudgetInput { budget: number; perP4P: number }

export const BUDGET_FILE = 'process/sk03-budget-inputs.json';

/** Check and normalise the parsed JSON file: month key → inputs. */
export function parseBudgetInputs(raw: unknown): Record<string, BudgetInput> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${BUDGET_FILE} must be an object of "BBBB_MM": { budget, perP4P }`);
  const out: Record<string, BudgetInput> = {};
  for (const [month, v] of Object.entries(raw as Record<string, unknown>)) {
    if (month.startsWith('_')) continue; // comment keys
    const { budget, perP4P } = (v ?? {}) as Record<string, unknown>;
    if (!/^\d{4}_\d{2}$/.test(month) || typeof budget !== 'number' || typeof perP4P !== 'number' || !(budget > 0) || !(perP4P > 0)) {
      throw new Error(`${BUDGET_FILE}: bad entry "${month}" (needs "BBBB_MM": { "budget": number > 0, "perP4P": number > 0 })`);
    }
    out[month] = { budget, perP4P };
  }
  return out;
}

/** Read ./sk03-budget-inputs.json (next to this file). Throws on a malformed file. */
export function loadBudgetInputs(): Record<string, BudgetInput> {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  return parseBudgetInputs(JSON.parse(fs.readFileSync(path.join(__dirname, 'sk03-budget-inputs.json'), 'utf8')));
}
