/**
 * xlsx-cells.ts
 *
 * Cell-level reading of a workbook, for telling which tab of an emailed
 * workbook an archived copy came from, and how far the copy has drifted
 * from it (values, and formatting as ExcelJS reads it).
 */

import ExcelJS from "exceljs";

export interface TabCells {
  name  : string;
  values: Map<string, string>;   // address → value as text, non-empty cells only
  styles: Map<string, string>;   // address → the cell's formatting, serialised
}

function cellText(v: ExcelJS.CellValue): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    if ("result" in v) return cellText((v as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue);
    if ("richText" in v) return (v as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join("").trim() || null;
    if ("text" in v) return String((v as ExcelJS.CellHyperlinkValue).text).trim() || null;
    if ("error" in v) return String((v as ExcelJS.CellErrorValue).error);
    return JSON.stringify(v);
  }
  return String(v).trim() || null;
}

/** Every worksheet of a workbook, in ExcelJS order (chartsheets are not loaded). */
export async function readTabs(buffer: Buffer): Promise<TabCells[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  return wb.worksheets.map((ws) => {
    const values = new Map<string, string>();
    const styles = new Map<string, string>();
    ws.eachRow({ includeEmpty: true }, (row) => {
      row.eachCell({ includeEmpty: true }, (c) => {
        // A merged range's value lives in its top-left cell; ExcelJS repeats
        // it in every other cell of the range, which would count it N times.
        const t = c.isMerged && c.master.address !== c.address ? null : cellText(c.value);
        if (t !== null) values.set(c.address, t);
        styles.set(c.address, JSON.stringify(c.style ?? {}));
      });
    });
    return { name: ws.name, values, styles };
  });
}

/** Share of non-empty cells two tabs agree on, 0–1 (1 = the same values in the same places). */
export function valueAgreement(a: TabCells, b: TabCells): number {
  const cells = new Set([...a.values.keys(), ...b.values.keys()]);
  if (cells.size === 0) return 0;
  let same = 0;
  for (const addr of cells) if (a.values.get(addr) === b.values.get(addr)) same++;
  return same / cells.size;
}

/** How many cells differ in value, and in formatting, between two tabs. */
export function cellDrift(a: TabCells, b: TabCells): { values: number; styles: number } {
  let values = 0;
  for (const addr of new Set([...a.values.keys(), ...b.values.keys()])) if (a.values.get(addr) !== b.values.get(addr)) values++;
  let styles = 0;
  for (const addr of new Set([...a.styles.keys(), ...b.styles.keys()])) {
    if ((a.styles.get(addr) ?? "{}") !== (b.styles.get(addr) ?? "{}")) styles++;
  }
  return { values, styles };
}
