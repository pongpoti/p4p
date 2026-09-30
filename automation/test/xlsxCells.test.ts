import { test } from "node:test";
import assert   from "node:assert/strict";
import ExcelJS  from "exceljs";
import { cellDrift, readTabs, reproduced, valueAgreement } from "../xlsx-cells.js";
import { compareWithOriginal } from "../xlsx-compare.js";
import { keepOneSheet, workbookSheetNames } from "../xlsx-package.js";
import { workbook } from "./fixtures.js";

test("keepOneSheet keeps the chosen tab and nothing that only the others used", async () => {
  const original = await workbook(["cover", "ส.ค.69"]);
  assert.deepEqual(await workbookSheetNames(original), ["cover", "ส.ค.69"]);

  const second = (await keepOneSheet(original, 1))!;
  assert.deepEqual(await workbookSheetNames(second), ["ส.ค.69"]);
  const result = await compareWithOriginal(second, original);
  assert.equal(result.status, "same-content", JSON.stringify(result));

  assert.equal(await keepOneSheet(original, 2), null);
  const single = await workbook(["ส.ค.69"]);
  assert.ok((await keepOneSheet(single, 0))!.equals(single), "a one-tab workbook is kept byte for byte");
});

test("the tab a copy came from is the one whose values agree", async () => {
  const [cover, month] = await readTabs(await workbook(["cover", "ส.ค.69"]));
  const [copy]         = await readTabs(await workbook(["ส.ค.69"]));
  assert.equal(valueAgreement(copy!, month!), 1);
  assert.ok(valueAgreement(copy!, cover!) < 1, "the cover tab shares some cells but not all");
});

test("a changed merged header counts as one changed value", async () => {
  const make = async (header: string) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("ส.ค.69");
    ws.mergeCells("A1:J1");
    ws.getCell("A1").value = header;
    ws.getCell("B2").value = 42;
    return Buffer.from(await wb.xlsx.writeBuffer());
  };
  const [a] = await readTabs(await make("ชื่อแพทย์ สมชาย ใจดี"));
  const [b] = await readTabs(await make("-1"));
  assert.equal(cellDrift(a!, b!).values, 1);
});

test("a rebuild that repeats a merged header still reproduces the original, and changes no value", async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("ส.ค.69");
  ws.mergeCells("A1:J1");
  ws.getCell("A1").value = "ชื่อแพทย์ สมชาย ใจดี";
  ws.getCell("B2").value = 42;
  const [original] = await readTabs(Buffer.from(await wb.xlsx.writeBuffer()));

  const flat = new ExcelJS.Workbook();
  const fs   = flat.addWorksheet("ส.ค.69");
  for (const col of "ABCDEFGHIJ") fs.getCell(`${col}1`).value = "ชื่อแพทย์ สมชาย ใจดี";
  fs.getCell("B2").value = 42;
  const [rebuilt] = await readTabs(Buffer.from(await flat.xlsx.writeBuffer()));

  assert.equal(reproduced(rebuilt!, original!), 1);
  assert.equal(cellDrift(rebuilt!, original!).values, 0);
});
