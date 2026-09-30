import { test } from "node:test";
import assert   from "node:assert/strict";
import ExcelJS  from "exceljs";
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
