/**
 * fill-score.ts
 *
 * Step 4.5 of the nightly build (process.ts fillMissingScores): the score a
 * doctor's Drive workbook states, read by the same extractor the submission
 * pipeline uses (lib/p4p-score.ts resolveScore, the vendored copy of
 * automation/claude-analyst.ts, with its rowsFromWorksheet cell reading), and
 * whether it is safe to write to the roster with nobody checking it.
 *
 * The roster score is what SK03 column J pays on, and the rule is that a
 * doctor's score is the total they wrote on the last row of their form,
 * never a recalculation. So only a total the workbook itself states is
 * written: a grand-total row or a total typed as text (isHighConfidence, the
 * same gate /upload/score uses). A sub-total, a whole-sheet guess or a
 * recalculation is left empty for an admin, and so is a workbook with more
 * than one sheet holding data, where which month's sheet holds the score is
 * not something this step can tell.
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
  isHighConfidence(method: string): boolean;
  rowsFromWorksheet(ws: Worksheet): Row[];
};

export interface StatedScore {
  /** What the extractor read, or null when it read nothing. */
  score: number | null;
  /** How it was read, or why nothing was. */
  method: string;
  /** True only for a stated total that may be saved without a person. */
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
  if (sheets.length > 1) return { score: null, method: `${sheets.length} sheets with data`, write: false };

  const { score, method } = p4p.resolveScore(p4p.rowsFromWorksheet(sheets[0]));
  if (score === null || !(score > 0)) return { score: null, method, write: false };
  return { score, method, write: p4p.isHighConfidence(method) };
}
