import { test } from "node:test";
import assert   from "node:assert/strict";
import ExcelJS  from "exceljs";
import { pickRestoreTab } from "../restore-pick.js";
import { readTabs } from "../xlsx-cells.js";
import { keepOneSheet, workbookSheetNames } from "../xlsx-package.js";

type Tab = { name: string; title: string; values: number[] };

async function workbook(tabs: Tab[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const t of tabs) {
    const ws = wb.addWorksheet(t.name);
    ws.getCell("A1").value = t.title;
    ["ประเภทงาน", "กิจกรรม", "แต้ม"].forEach((h, i) => { ws.getCell(3, i + 1).value = h; });
    t.values.forEach((v, i) => { ws.getCell(4 + i, 2).value = v; });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test("the month's tab is taken from the workbook the copy came from, not another attachment", async () => {
  // One message, two physicians' files. The copy holds June from the second
  // file; the first file's only tab is July and happens to share June's numbers.
  const june  = { name: "มิถุนายน 69", title: "ชื่อแพทย์ สมหญิง เดือน มิถุนายน พ.ศ.2569", values: [1, 2, 3, 4, 5, 6] };
  const july  = { name: "กรกฎาคม 69", title: "ชื่อแพทย์ สมหญิง เดือน กรกฎาคม พ.ศ.2569", values: [9, 9, 9, 9, 9, 9] };
  const other = await workbook([{ name: "Sheet1", title: "ชื่อแพทย์ สมชาย เดือน กรกฎาคม พ.ศ.2569", values: june.values }]);
  const hers  = await workbook([june, july]);
  const [copyTab] = await readTabs((await keepOneSheet(hers, 0))!);

  const pick = await pickRestoreTab(copyTab!, [other, hers], 7, 2569);
  assert.ok(pick);
  assert.equal(pick.closest.original, hers);
  assert.equal(pick.closest.keepPos, 0);
  assert.equal(pick.best.original, hers, "July must come from her own file");
  assert.equal((await workbookSheetNames(pick.best.original))?.[pick.best.keepPos], "กรกฎาคม 69");
});

test("a copy that already holds the month's tab keeps it", async () => {
  const june = { name: "มิถุนายน 69", title: "ชื่อแพทย์ สมหญิง เดือน มิถุนายน พ.ศ.2569", values: [1, 2, 3] };
  const july = { name: "กรกฎาคม 69", title: "ชื่อแพทย์ สมหญิง เดือน กรกฎาคม พ.ศ.2569", values: [4, 5, 6] };
  const hers = await workbook([june, july]);
  const [copyTab] = await readTabs((await keepOneSheet(hers, 1))!);

  const pick = await pickRestoreTab(copyTab!, [hers], 7, 2569);
  assert.ok(pick);
  assert.equal(pick.best, pick.closest);
  assert.equal(pick.best.keepPos, 1);
  assert.equal(pick.best.says, true);
});
