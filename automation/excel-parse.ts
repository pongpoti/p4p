/**
 * excel-parse.js
 *
 * Shared "pick the right sheet, flatten it to row objects" logic used by
 * automation/scripts/backfill-drive-scores.mjs and
 * automation/scripts/match-sender-emails.mjs. It mirrors (a trimmed-down
 * version of) index.js's firstSheetToRows — this was previously copy-pasted
 * between the two scripts independently, so a fix landing in one copy had no
 * way to reach the other.
 */

import ExcelJS from "exceljs";
import type { Row, CellValue } from "./types.js";

export interface ParsedExcel {
  rows: Row[];
  sheetName: string;
  sheetCount: number;
}

/**
 * @param buffer
 * @param targetMonth  1-12 — hint for picking the right sheet in a
 *   multi-sheet workbook (matched against MONTH_TOKENS_BY_NUM).
 * @param monthTokensByNum  from ../months.js
 */
export async function parseExcel(
  buffer: Buffer,
  targetMonth: number | null = null,
  monthTokensByNum: Record<number, string[]> = {}
): Promise<ParsedExcel> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);

  const sheets = wb.worksheets;
  if (!sheets.length) throw new Error("Workbook has no sheets");

  function nonNullCount(ws: ExcelJS.Worksheet): number {
    let n = 0;
    ws.eachRow(row => row.eachCell({ includeEmpty: false }, cell => {
      if (cell.value !== null && cell.value !== undefined) n++;
    }));
    return n;
  }

  // Default: first non-empty sheet
  let idx = 0;
  if (nonNullCount(sheets[0]!) < 3 && sheets.length > 1) idx = 1;

  // Month-name match for multi-sheet workbooks
  if (targetMonth && sheets.length > 1) {
    const toks = monthTokensByNum[targetMonth] ?? [];
    const m = sheets.findIndex(ws => toks.some(t => ws.name.toLowerCase().includes(t)));
    if (m !== -1 && nonNullCount(sheets[m]!) >= 3) idx = m;
  }

  const ws   = sheets[idx]!;
  const rows: Row[] = [];

  ws.eachRow(row => {
    if (!row.hasValues) return;
    const obj: Row = {};
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const key = `col_${col}`;
      const val = cell.value;
      const isMaster = val !== null && typeof val === "object" && "formula" in val;
      const isClone  = val !== null && typeof val === "object" && "sharedFormula" in val && !("formula" in val);
      if (isMaster || isClone) {
        const r = cell.result;
        obj[key] = isClone
          ? (typeof r === "number" ? r : null)
          : (r instanceof Date ? r.toISOString() : (r ?? null) as CellValue);
        return;
      }
      if (val === null || val === undefined)                          obj[key] = null;
      else if (val instanceof Date)                                   obj[key] = val.toISOString();
      else if (typeof val === "object" && Array.isArray((val as { richText?: unknown }).richText)) {
        obj[key] = (val as { richText: { text?: string }[] }).richText.map(r => r.text ?? "").join("");
      }
      else if (typeof val === "object" && "text" in val)              obj[key] = String((val as { text?: unknown }).text ?? "");
      else                                                            obj[key] = val as CellValue;
    });
    if (Object.keys(obj).length) rows.push(obj);
  });

  return { rows, sheetName: ws.name, sheetCount: sheets.length };
}
