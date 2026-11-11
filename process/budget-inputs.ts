/**
 * The month's budget and per P4P for the SK03 (staff Y9, intern W9), read
 * from the "Monthly Budget Inputs" table in process/FORMULA.md (Pong,
 * 2026-11-11). A month with no row, or a blank cell, leaves that cell empty.
 *
 *   | Month | Budget | N | perP4P |
 *   | 2569_08 | 2,189,874.33 | 229 | 9,562.77 |
 *
 * per P4P comes from its own column; if that is blank but Budget and N are
 * there, it is round(Budget ÷ N, 2), as the table's rule says.
 */

import fs from 'fs';
import path from 'path';

export interface BudgetInput { budget: number | null; per_p4p: number | null }

const num = (s: string | undefined): number | null => {
  const t = (s ?? '').replace(/[,\s฿]/g, '');
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return n > 0 ? n : null;
};

/** Every month row of the Monthly Budget Inputs table, by month key. */
export function parseBudgetTable(md: string): Map<string, BudgetInput> {
  const out = new Map<string, BudgetInput>();
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#+\s*Monthly Budget Inputs\s*$/i.test(l.trim()));
  if (start < 0) return out;
  let cols: string[] | null = null;
  for (const line of lines.slice(start + 1)) {
    if (/^#+\s/.test(line.trim())) break;
    if (!line.trim().startsWith('|')) { if (cols) break; continue; }
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (!cols) { cols = cells.map((c) => c.toLowerCase()); continue; }
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    const at = (name: string): string | undefined => {
      const i = cols!.indexOf(name);
      return i < 0 ? undefined : cells[i];
    };
    const month = at('month');
    if (!month || !/^\d{4}_\d{2}$/.test(month)) continue;
    const budget = num(at('budget'));
    const n = num(at('n'));
    let per = num(at('perp4p'));
    if (per == null && budget != null && n != null) per = Math.round((budget / n) * 100) / 100;
    out.set(month, { budget, per_p4p: per });
  }
  return out;
}

/** The month's row from process/FORMULA.md; both null if it has none. */
export function loadBudgetInput(monthKey: string, file = path.join(__dirname, 'FORMULA.md')): BudgetInput {
  let md = '';
  try { md = fs.readFileSync(file, 'utf8'); } catch { /* no file → empty cells */ }
  return parseBudgetTable(md).get(monthKey) ?? { budget: null, per_p4p: null };
}
