/**
 * Monthly budget inputs for the SK03 sheet, read from the private repo
 * pongpoti/p4p-analysis (docs/formula/formula.md, section
 * "Monthly Budget Inputs"):
 *
 *   | Month | Budget | N (doc) | N (actual) | perP4P |
 *   | 2569_06 | 2,159,731.84 | 224 | 199 | 9,641.66 |
 *
 * Budget goes to the staff sheet's งบทั้งหมด (W9) and perP4P to the intern
 * sheet's perP4P (U9). A month that is not in the table, a missing token or a
 * failed fetch leaves both at 0 (typed in by hand), with a warning in the log.
 *
 * The token (secret P4P_ANALYSIS_TOKEN) needs read access to the contents of
 * pongpoti/p4p-analysis only. This repo is public, so the amounts themselves
 * are never written to the log.
 */

export interface BudgetInput { budget: number; perP4P: number }

export const BUDGET_REPO = 'pongpoti/p4p-analysis';
export const BUDGET_PATH = 'docs/formula/formula.md';
export const BUDGET_HEADING = 'Monthly Budget Inputs';

const num = (s: string) => Number(s.replace(/[,\s฿]/g, ''));

/** Parse the "Monthly Budget Inputs" table of formula.md into month key → inputs. */
export function parseBudgetTable(markdown: string): Record<string, BudgetInput> {
  const out: Record<string, BudgetInput> = {};
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex(l => /^#+\s/.test(l) && l.includes(BUDGET_HEADING));
  if (start < 0) return out;

  let cols: string[] | null = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^#+\s/.test(line)) break;              // next section
    if (!line.startsWith('|')) { if (cols) break; else continue; }
    const cells = line.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    if (!cols) { cols = cells.map(c => c.toLowerCase()); continue; }
    if (cells.every(c => /^:?-+:?$/.test(c))) continue; // |---|---|
    const month  = cells[cols.indexOf('month')];
    const budget = num(cells[cols.indexOf('budget')] ?? '');
    const perP4P = num(cells[cols.indexOf('perp4p')] ?? '');
    if (/^\d{4}_\d{2}$/.test(month ?? '') && Number.isFinite(budget) && Number.isFinite(perP4P) && budget > 0 && perP4P > 0) {
      out[month] = { budget, perP4P };
    }
  }
  return out;
}

/**
 * Fetch formula.md from p4p-analysis and parse its budget table.
 * Never throws: on any problem it returns {} and a reason for the log.
 */
export async function fetchBudgetInputs(token: string | undefined): Promise<{ inputs: Record<string, BudgetInput>; problem?: string }> {
  if (!token) return { inputs: {}, problem: 'secret P4P_ANALYSIS_TOKEN is not set' };
  try {
    const res = await fetch(`https://api.github.com/repos/${BUDGET_REPO}/contents/${BUDGET_PATH}?ref=main`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.raw+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'p4p-sk03-nightly',
      },
    });
    if (!res.ok) return { inputs: {}, problem: `GitHub returned HTTP ${res.status} for ${BUDGET_REPO}/${BUDGET_PATH}` };
    const inputs = parseBudgetTable(await res.text());
    if (Object.keys(inputs).length === 0) return { inputs, problem: `no rows found under "${BUDGET_HEADING}" in ${BUDGET_PATH}` };
    return { inputs };
  } catch (e) {
    return { inputs: {}, problem: `fetch failed: ${(e as Error).message}` };
  }
}
