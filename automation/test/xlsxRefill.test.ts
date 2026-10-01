import { test } from "node:test";
import assert   from "node:assert/strict";
import ExcelJS  from "exceljs";
import JSZip    from "jszip";
import { cellDrift, readTabs, reproduced } from "../xlsx-cells.js";
import { packageProblem } from "../xlsx-package.js";
import { hasNoText, refillValues } from "../xlsx-refill.js";
import { blankCorrection, formatted } from "./fixtures.js";

test("a blank-looking correction gets its formatting and text back, and keeps every number it changed", async () => {
  const styled = await formatted();
  const values = await blankCorrection();
  assert.equal(await hasNoText(values), true);
  assert.equal(await hasNoText(styled), false);

  const out = await refillValues(styled, values);
  assert.ok(out);
  assert.equal(out.added, 0);
  assert.equal(await packageProblem(out.buffer), null);

  const [s] = await readTabs(styled), [v] = await readTabs(values), [o] = await readTabs(out.buffer);
  assert.equal(reproduced(o!, v!), 1, "every value of the correction");
  assert.equal(o!.values.get("A1"), "ชื่อแพทย์ สมหญิง ใจดี เดือน กรกฎาคม 2569");
  assert.equal(o!.values.get("B5"), "ROUND ผู้ป่วยใน");
  assert.equal(o!.values.get("B7"), "รวมแต้มทั้งหมด");
  assert.equal(o!.values.has("E5"), false, "what the correction removed stays removed");
  assert.equal(o!.values.get("G7"), "35");
  assert.equal(cellDrift(s!, o!).styles, 0, "every format of the formatted file");

  const again = await refillValues(styled, values);
  assert.ok(again!.buffer.equals(out.buffer), "the same inputs give the same bytes");
});

test("a correction in a cell the formatted file never had is kept, with the default format", async () => {
  const out = await refillValues(await formatted(), await blankCorrection([["C9", 12]]));
  assert.ok(out);
  assert.equal(out.added, 1);
  assert.equal(await packageProblem(out.buffer), null);
  const [o] = await readTabs(out.buffer);
  assert.equal(o!.values.get("C9"), "12");
  assert.equal(o!.values.get("B7"), "รวมแต้มทั้งหมด");
});

test("only one-tab workbooks are refilled", async () => {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet("a").getCell("A1").value = 1;
  wb.addWorksheet("b").getCell("A1").value = 2;
  const two = Buffer.from(await wb.xlsx.writeBuffer());
  assert.equal(await refillValues(two, await blankCorrection()), null);
  assert.equal(await refillValues(await formatted(), two), null);
});

const VALID_CELL_TYPE = /^(?:b|d|e|inlineStr|n|s|str)$/;
async function cellTypes(buf: Buffer): Promise<string[]> {
  const xml = await (await JSZip.loadAsync(buf)).file("xl/worksheets/sheet1.xml")!.async("string");
  return [...xml.matchAll(/<c\b[^>]*?\st="([^"]*)"[^>]*?\/?>/g)].map((m) => m[1]!);
}

test("shared formulas keep their cells' own type — never the formula's t=\"shared\"", async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("ก.ค.69");
  ws.getCell("D5").value = 3;
  ws.getCell("D6").value = 4;
  ws.getCell("G5").value = { formula: "D5*2", shareType: "shared", ref: "G5:G6", result: 6 } as ExcelJS.CellValue;
  ws.getCell("G6").value = { sharedFormula: "G5", result: 8 } as ExcelJS.CellValue;
  const values = Buffer.from(await wb.xlsx.writeBuffer());
  const xml = await (await JSZip.loadAsync(values)).file("xl/worksheets/sheet1.xml")!.async("string");
  assert.match(xml, /<f t="shared"/, "the fixture must carry a shared formula");

  const out = await refillValues(await formatted(), values);
  assert.ok(out);
  const bad = (await cellTypes(out.buffer)).filter((t) => !VALID_CELL_TYPE.test(t));
  assert.deepEqual(bad, [], "every cell type must be one Excel knows");
  const [o] = await readTabs(out.buffer);
  assert.equal(o!.values.get("G6"), "8");
});

test("text the way SheetJS writes it (t=\"str\", no formula) is text", async () => {
  const zip  = await JSZip.loadAsync(await blankCorrection());
  const path = "xl/worksheets/sheet1.xml";
  const xml  = await zip.file(path)!.async("string");
  zip.file(path, xml.replace(/<c r="D5"([^>]*)>/, '<c r="B5"$1 t="str"><v>ROUND ผู้ป่วยใน</v></c><c r="D5"$1>'));
  const sheetjs = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
  assert.equal(await hasNoText(sheetjs), false);

  // A t="str" cell WITH a formula is only a computed result, not text someone typed.
  zip.file(path, xml.replace(/<c r="D5"([^>]*)>/, '<c r="B5"$1 t="str"><f>"x"</f><v>x</v></c><c r="D5"$1>'));
  assert.equal(await hasNoText(Buffer.from(await zip.generateAsync({ type: "nodebuffer" }))), true);
});
