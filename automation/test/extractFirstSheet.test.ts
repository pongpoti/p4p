import { test } from "node:test";
import assert   from "node:assert/strict";
import ExcelJS  from "exceljs";
import JSZip    from "jszip";
import { extractFirstSheetBuffer, guessingBetweenTabs, monthSheet } from "../index.js";

// extractFirstSheetBuffer() is what gets archived to Drive. It once rebuilt
// xl/_rels/workbook.xml.rels with only the worksheet relationship, so Excel
// could not find styles/sharedStrings/theme and showed every Drive copy with
// blank text and no formatting.

async function workbook(sheets: { name: string; cells: [string, string | number][] }[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    for (const [addr, value] of s.cells) {
      const cell = ws.getCell(addr);
      cell.value = value;
      cell.font  = { bold: true, name: "Browallia New", size: 16 };
      cell.fill  = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF9CB9C" } };
    }
    ws.pageSetup.printArea = "A1:C3";
  }
  wb.views = [{ x: 0, y: 0, width: 10000, height: 20000, firstSheet: 0, activeTab: sheets.length - 1, visibility: "visible" }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const physicianSheet = {
  name : "ส.ค.69",
  cells: [
    ["A1", "ชื่อแพทย์ สมชาย ใจดี"],
    ["A2", "เดือน สิงหาคม 2569"],
    ["B5", "ประเภทงาน"],
    ["C5", 42],
  ] as [string, string | number][],
};

async function parts(buf: Buffer) {
  const zip  = await JSZip.loadAsync(buf);
  const text = async (p: string) => (await zip.file(p)?.async("string")) ?? "";
  return {
    zip,
    names: Object.keys(zip.files).filter((p) => !zip.files[p]!.dir),
    dirs : Object.keys(zip.files).filter((p) => zip.files[p]!.dir),
    wb   : await text("xl/workbook.xml"),
    rels : await text("xl/_rels/workbook.xml.rels"),
    ct   : await text("[Content_Types].xml"),
  };
}

test("a one-sheet workbook is archived byte-for-byte", async () => {
  const input = await workbook([physicianSheet]);
  const out   = await extractFirstSheetBuffer(input);
  assert.ok(out);
  assert.ok(out.equals(input), "single-sheet files must not be rebuilt");
});

test("dropping a sheet keeps styles, sharedStrings and theme linked", async () => {
  const input = await workbook([
    { name: "cover", cells: [["A1", "x"]] },  // < 3 cells: skipped for sheet 2
    physicianSheet,
  ]);
  const out = await extractFirstSheetBuffer(input);
  assert.ok(out);
  const p = await parts(out);

  const sheets = p.wb.match(/<sheet\s[^>]*>/g) ?? [];
  assert.equal(sheets.length, 1);
  assert.match(sheets[0]!, /name="ส\.ค\.69"/);

  const relTypes = [...p.rels.matchAll(/Type="[^"]*\/([^"/]+)"/g)].map((m) => m[1]);
  for (const t of ["styles", "sharedStrings", "theme"]) {
    assert.ok(relTypes.includes(t), `workbook rels lost the ${t} relationship`);
  }
  assert.equal(relTypes.filter((t) => t === "worksheet").length, 1);

  // Every relationship and content-type override must name a part that exists.
  const sheetRId = sheets[0]!.match(/r:id="([^"]+)"/)![1];
  assert.match(p.rels, new RegExp(`Id="${sheetRId}"`));
  for (const [, target] of p.rels.matchAll(/Target="([^"]+)"/g)) {
    assert.ok(p.names.includes(`xl/${target}`), `rels point at missing part xl/${target}`);
  }
  for (const [, part] of p.ct.matchAll(/PartName="\/([^"]+)"/g)) {
    assert.ok(p.names.includes(part!), `[Content_Types].xml overrides missing part ${part}`);
  }
  assert.deepEqual(p.dirs, [], "Excel never writes directory entries");

  // Sheet-scoped names: the dropped sheet's is gone, the kept one's is now tab 0.
  const names = p.wb.match(/<definedName\s[^>]*>/g) ?? [];
  assert.equal(names.length, 1);
  assert.match(names[0]!, /localSheetId="0"/);
  assert.doesNotMatch(p.wb, /activeTab=/);

  const back = new ExcelJS.Workbook();
  await back.xlsx.load(out as unknown as ExcelJS.Buffer);
  assert.equal(back.worksheets.length, 1);
  const ws = back.worksheets[0]!;
  assert.equal(ws.getCell("A1").value, "ชื่อแพทย์ สมชาย ใจดี");
  assert.equal(ws.getCell("B5").value, "ประเภทงาน");
  assert.equal(ws.getCell("C5").value, 42);
  assert.equal(ws.getCell("B5").font?.bold, true);
  assert.equal((ws.getCell("B5").fill as ExcelJS.FillPattern).fgColor?.argb, "FFF9CB9C");
});

test("a blank workbook is still refused", async () => {
  const out = await extractFirstSheetBuffer(await workbook([{ name: "empty", cells: [["A1", "x"]] }]));
  assert.equal(out, null);
});

test("a workbook with a tab per month archives the month that was scored", async () => {
  const july  = { name: "ก.ค.69", cells: [["A1", "ชื่อแพทย์ สมชาย ใจดี"], ["A2", "เดือน กรกฎาคม 2569"], ["C5", 7]] as [string, string | number][] };
  const input = await workbook([july, physicianSheet]);

  const month = await monthSheet(input, 8, 2569);
  assert.deepEqual(month, { name: "ส.ค.69", matched: true, sheets: ["ก.ค.69", "ส.ค.69"], says: ["ส.ค.69"], filled: ["ก.ค.69", "ส.ค.69"] });

  const out = await extractFirstSheetBuffer(input, month.name);
  assert.ok(out);
  const wb = (await parts(out)).wb;
  assert.deepEqual((wb.match(/<sheet\s[^>]*>/g) ?? []).map((t) => t.match(/name="([^"]*)"/)![1]), ["ส.ค.69"]);

  // Without a name it is still the first tab with content, as before.
  const first = (await parts((await extractFirstSheetBuffer(input))!)).wb;
  assert.match(first, /name="ก\.ค\.69"/);
});

test("a tab whose title says the month counts, whatever the tab is called", async () => {
  // January's data under a stale "May" tab, next to an empty "Jan" template.
  const may = { name: "May", cells: [["A1", "ชื่อแพทย์ สมชาย ใจดี"], ["A2", "เดือน มกราคม 2569"], ["C5", 30]] as [string, string | number][] };
  const jan = { name: "Jan", cells: [["A3", "ประเภทงาน"], ["B3", "กิจกรรม"], ["C3", "D1"]] as [string, string | number][] };
  const month = await monthSheet(await workbook([may, jan]), 1, 2569);
  assert.deepEqual([...month.says].sort(), ["Jan", "May"]);
});

// The email path refuses a workbook when it would have to guess which tab is
// the report. A report whose title names no month, sent with an empty form
// tab beside it, leaves nothing to guess.
const report = { name: "ใบ p4p", cells: [["A1", "ชื่อแพทย์"], ["B1", "สมหญิง ใจดี"], ["B5", "ประเภทงาน"], ["C5", 42]] as [string, string | number][] };
const emptyForm = { name: "ใบแนบ OPD", cells: [] as [string, string | number][] };

test("an empty tab beside the report is nothing to choose between", async () => {
  const month = await monthSheet(await workbook([report, emptyForm]), 9, 2569);
  assert.equal(month.matched, false, "the report names no month — the email subject does");
  assert.deepEqual(month.filled, ["ใบ p4p"]);
  assert.equal(month.name, "ใบ p4p");
  assert.equal(guessingBetweenTabs(month.filled, month.matched), false);
});

test("two tabs with content and no month named is still a guess", async () => {
  const other = { ...report, name: "ใบ p4p (2)" };
  const month = await monthSheet(await workbook([report, other]), 9, 2569);
  assert.equal(guessingBetweenTabs(month.filled, month.matched), true);

  const september = { name: "ก.ย.69", cells: [["A1", "ชื่อแพทย์ สมหญิง ใจดี"], ["A2", "เดือน กันยายน 2569"], ["C5", 9]] as [string, string | number][] };
  const named = await monthSheet(await workbook([report, september]), 9, 2569);
  assert.equal(guessingBetweenTabs(named.filled, named.matched), false, "a tab that names the month settles it");
  assert.equal(named.name, "ก.ย.69");
});

