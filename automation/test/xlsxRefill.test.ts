import { test } from "node:test";
import assert   from "node:assert/strict";
import ExcelJS  from "exceljs";
import { cellDrift, readTabs, reproduced } from "../xlsx-cells.js";
import { packageProblem } from "../xlsx-package.js";
import { hasNoText, refillValues } from "../xlsx-refill.js";

// A physician's formatted report, and the same report corrected on a Drive
// copy that opened blank: numbers and formulas only, no text, no formatting.

const days = ["D5", "E5", "F5"];

async function formatted(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("ก.ค.69");
  ws.mergeCells("A1:G1");
  ws.getCell("A1").value = "ชื่อแพทย์ สมหญิง ใจดี เดือน กรกฎาคม 2569";
  ws.getCell("A1").font  = { bold: true, size: 16 };
  ws.getCell("B5").value = "ROUND ผู้ป่วยใน";
  for (const addr of [...days, "G5"]) {
    ws.getCell(addr).fill   = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF9CB9C" } };
    ws.getCell(addr).border = { top: { style: "thin" }, bottom: { style: "thin" } };
  }
  ws.getCell("D5").value = 3;
  ws.getCell("E5").value = 2;
  ws.getCell("F5").value = 4;
  ws.getCell("G5").value = { formula: "SUM(D5:F5)", result: 9 };
  ws.getCell("B7").value = "รวมแต้มทั้งหมด";
  ws.getCell("G7").value = { formula: "G5*5", result: 45 };
  ws.getCell("G7").font  = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function blankCorrection(extra: [string, number][] = []): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("ก.ค.69");
  ws.mergeCells("A1:G1");
  ws.getCell("D5").value = 3;
  ws.getCell("F5").value = 4;                                      // E5 removed
  ws.getCell("G5").value = { formula: "SUM(D5:F5)", result: 7 };
  ws.getCell("G7").value = { formula: "G5*5", result: 35 };
  for (const [addr, v] of extra) ws.getCell(addr).value = v;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

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
