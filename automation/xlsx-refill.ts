/**
 * xlsx-refill.ts
 *
 * Puts a physician's corrected numbers back into the formatted workbook they
 * first sent, when the correction was made on a Drive copy that opened blank.
 *
 * The old archive step unlinked styles and shared strings (xlsx-package.ts,
 * THE DAMAGE). A physician who downloaded such a copy saw a grid of bare
 * numbers, corrected them and sent that back: the file they sent has no text
 * and one plain format, because their spreadsheet app saved only what it
 * could show. Its numbers and formulas are the correction; the labels and
 * formatting were never deleted, only invisible. So the result takes
 *   - every number, formula and cached result from the correction, and drops
 *     what the correction dropped;
 *   - every text cell from the earlier file where the correction has nothing
 *     (text it could not have seen);
 *   - every cell's format, and every other part of the package, from the
 *     earlier file.
 */

import JSZip from "jszip";
import { parseRels, workbookPartPath, xmlAttr } from "./xlsx-package.js";

interface Cell { attrs: string; inner: string }

const CELL = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
const ROW  = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;

function colOf(addr: string): number {
  let n = 0;
  for (const ch of addr.replace(/\d+$/, "")) n = n * 26 + ch.charCodeAt(0) - 64;
  return n;
}
const rowOf = (addr: string): number => Number(addr.replace(/^[A-Z]+/, ""));

async function onlySheet(zip: JSZip): Promise<string | null> {
  const wb   = await zip.file("xl/workbook.xml")?.async("string");
  const tags = wb?.match(/<sheet\s[^>]*>/g) ?? [];
  if (tags.length !== 1) return null;
  const rels = parseRels((await zip.file("xl/_rels/workbook.xml.rels")?.async("string")) ?? "");
  const rel  = rels.find((r) => r.id === xmlAttr(tags[0]!, "r:id"));
  return rel && !rel.external ? workbookPartPath(rel.target) : null;
}

/** Cells with content (a value, formula or inline text), by address. Shared strings become inline. */
async function contentCells(zip: JSZip, sheetXml: string): Promise<Map<string, Cell>> {
  const sst  = (await zip.file("xl/sharedStrings.xml")?.async("string")) ?? "";
  const strs = [...sst.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map((m) => m[1] ?? "");
  const out  = new Map<string, Cell>();
  const data = sheetXml.match(/<sheetData>([\s\S]*?)<\/sheetData>/)?.[1] ?? "";
  for (const m of data.matchAll(CELL)) {
    const inner = m[2] ?? "";
    const addr  = xmlAttr(m[0], "r");
    if (!addr || !/<(?:f|v|is)\b/.test(inner)) continue;
    const t = xmlAttr(m[0], "t");
    if (t === "s") {
      const text = strs[Number(inner.match(/<v>(\d+)<\/v>/)?.[1])];
      out.set(addr, { attrs: ' t="inlineStr"', inner: `<is>${text ?? ""}</is>` });
    } else {
      out.set(addr, { attrs: t ? ` t="${t}"` : "", inner });
    }
  }
  return out;
}

/**
 * `styled` with the cell contents of `values`, per the rules above. Both must
 * be one-tab workbooks. `added` counts correction cells the earlier file had
 * no cell for (they take the default format). Null when either is not a
 * one-tab workbook.
 */
export async function refillValues(styled: Buffer, values: Buffer): Promise<{ buffer: Buffer; added: number } | null> {
  const sZip = await JSZip.loadAsync(styled);
  const vZip = await JSZip.loadAsync(values);
  const sPath = await onlySheet(sZip);
  const vPath = await onlySheet(vZip);
  if (!sPath || !vPath) return null;

  const sheetXml = await sZip.file(sPath)!.async("string");
  const fill     = await contentCells(vZip, await vZip.file(vPath)!.async("string"));
  const pending  = new Map(fill);
  let added = 0;

  const cellXml = (addr: string, style: string | null, c: Cell | null): string =>
    `<c r="${addr}"${style !== null ? ` s="${style}"` : ""}${c?.attrs ?? ""}${c ? `>${c.inner}</c>` : "/>"}`;

  const refillRow = (rowNum: number, body: string): { xml: string; grew: boolean } => {
    const cells: { col: number; xml: string }[] = [];
    let grew = false;
    for (const m of body.matchAll(CELL)) {
      const addr = xmlAttr(m[0], "r")!;
      const t    = xmlAttr(m[0], "t");
      const mine = fill.get(addr) ?? null;
      pending.delete(addr);
      const keepText = !mine && (t === "s" || t === "inlineStr") && /<(?:v|is)\b/.test(m[2] ?? "");
      cells.push({ col: colOf(addr), xml: keepText ? m[0] : cellXml(addr, xmlAttr(m[0], "s"), mine) });
    }
    for (const [addr, c] of pending) {
      if (rowOf(addr) !== rowNum) continue;
      cells.push({ col: colOf(addr), xml: cellXml(addr, null, c) });
      pending.delete(addr);
      added++;
      grew = true;
    }
    return { xml: cells.sort((a, b) => a.col - b.col).map((c) => c.xml).join(""), grew };
  };

  const newData = sheetXml.replace(/<sheetData>([\s\S]*?)<\/sheetData>|<sheetData\/>/, (_, data: string | undefined) => {
    const rows: { num: number; xml: string }[] = [];
    for (const m of (data ?? "").matchAll(ROW)) {
      const num = Number(xmlAttr(m[0], "r"));
      const { xml, grew } = refillRow(num, m[2] ?? "");
      // A row's spans are a hint Excel checks against its cells; drop it when cells were added.
      const attrs = grew ? m[1]!.replace(/\sspans="[^"]*"/, "") : m[1]!;
      rows.push({ num, xml: xml ? `<row${attrs}>${xml}</row>` : `<row${attrs}/>` });
    }
    const extraRows = new Set([...pending.keys()].map(rowOf));
    for (const num of extraRows) rows.push({ num, xml: `<row r="${num}">${refillRow(num, "").xml}</row>` });
    return `<sheetData>${rows.sort((a, b) => a.num - b.num).map((r) => r.xml).join("")}</sheetData>`;
  });

  // calcChain indexes the earlier file's formula cells; Excel rebuilds it on the next save.
  const calcChain = "xl/calcChain.xml";
  const out = new JSZip();
  for (const [p, f] of Object.entries(sZip.files)) {
    if (f.dir || p === calcChain) continue;
    let data: string | Buffer;
    if (p === sPath) data = newData;
    else if (p === "xl/_rels/workbook.xml.rels") data = (await f.async("string")).replace(/<Relationship\s[^>]*calcChain[^>]*\/>/g, "");
    else if (p === "[Content_Types].xml") data = (await f.async("string")).replace(/<Override\s[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/g, "");
    else data = await f.async("nodebuffer");
    out.file(p, data, { createFolders: false, date: f.date });
  }
  const buffer = await out.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  return { buffer, added };
}

/**
 * True when no sheet holds any text — no shared or inline strings: what a
 * copy that opened blank looks like once re-saved. Only such a file may be
 * refilled; one with text of its own is a correction to take as it is.
 */
export async function hasNoText(buffer: Buffer): Promise<boolean> {
  const zip = await JSZip.loadAsync(buffer);
  for (const p of Object.keys(zip.files).filter((p) => /^xl\/worksheets\/[^/]+\.xml$/.test(p))) {
    if (/<c\b[^>]*\st="(?:s|inlineStr)"/.test(await zip.file(p)!.async("string"))) return false;
  }
  return true;
}
