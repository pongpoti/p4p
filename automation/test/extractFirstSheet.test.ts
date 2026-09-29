import { test } from "node:test";
import assert   from "node:assert/strict";
import ExcelJS  from "exceljs";
import JSZip    from "jszip";
import { extractFirstSheetBuffer } from "../index.js";

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
    ["A1", "ชื่อแพทย์ วรงค์พร"],
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
  assert.equal(ws.getCell("A1").value, "ชื่อแพทย์ วรงค์พร");
  assert.equal(ws.getCell("B5").value, "ประเภทงาน");
  assert.equal(ws.getCell("C5").value, 42);
  assert.equal(ws.getCell("B5").font?.bold, true);
  assert.equal((ws.getCell("B5").fill as ExcelJS.FillPattern).fgColor?.argb, "FFF9CB9C");
});

test("a blank workbook is still refused", async () => {
  const out = await extractFirstSheetBuffer(await workbook([{ name: "empty", cells: [["A1", "x"]] }]));
  assert.equal(out, null);
});
