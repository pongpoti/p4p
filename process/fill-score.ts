/**
 * fill-score.ts
 *
 * Step 4.5 of the nightly build (process.ts fillMissingScores): the score a
 * doctor's Drive workbook states, read by the same extractor the submission
 * pipeline uses (lib/p4p-score.ts resolveScore, the vendored copy of
 * automation/claude-analyst.ts, with its rowsFromWorksheet cell reading).
 *
 * It accepts what the email pipeline accepts (any score above 0), so a score
 * filled here is the score the doctor's email would have saved. Which totals
 * to trust is a rule of the shared extractor, not of this step. The first
 * sheet holding data is read, as the old copy in process.ts read the first
 * sheet; Drive copies are single-sheet uploads in practice.
 *
 * Kept out of process.ts so the root tests can load it (process.ts runs its
 * pipeline on import): lib/__tests__/fill-score.test.mjs.
 */

import type { Worksheet } from 'exceljs';

type Row = Record<string, unknown>;

const ExcelJS = require('exceljs') as typeof import('exceljs');
// Typed here rather than `typeof import(...)` so this project's typecheck does
// not pull the root's lib/ (and its own exceljs) into the program.
const p4p = require('../lib/p4p-score') as {
  resolveScore(rows: Row[]): { score: number | null; method: string };
  rowsFromWorksheet(ws: Worksheet): Row[];
};

export interface StatedScore {
  /** What the extractor read, or null when it read nothing. */
  score: number | null;
  /** How it was read, or why nothing was. */
  method: string;
  /** True when the score may be written to the roster (score above 0). */
  write: boolean;
}

/** Filled cells on a sheet; under 3 counts as blank, as in the pipeline. */
function nonNullCount(ws: Worksheet): number {
  let count = 0;
  ws.eachRow((row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (cell.value !== null && cell.value !== undefined) count++;
    });
  });
  return count;
}

export async function statedScoreFromWorkbook(buffer: Buffer): Promise<StatedScore> {
  const wb = new ExcelJS.Workbook();
  // exceljs's bundled types predate Node 22's generic `Buffer<ArrayBufferLike>`
  // — a real Buffer at runtime, just a structural mismatch against the old type.
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheets = wb.worksheets.filter((ws) => nonNullCount(ws) >= 3);
  if (sheets.length === 0) return { score: null, method: 'no sheet with data', write: false };

  const { score, method } = p4p.resolveScore(p4p.rowsFromWorksheet(sheets[0]));
  if (score === null || !(score > 0)) return { score: null, method, write: false };
  return { score, method, write: true };
}
