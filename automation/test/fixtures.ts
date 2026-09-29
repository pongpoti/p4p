/**
 * Workbook fixtures shared by the package tests. Built in memory, never
 * committed: the damage is recreated exactly as the old
 * extractFirstSheetBuffer() did it.
 */
import ExcelJS from "exceljs";
import JSZip   from "jszip";

export async function workbook(sheetNames: string[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  sheetNames.forEach((name, i) => {
    const ws = wb.addWorksheet(name);
    ws.getCell("A1").value = i === 0 && sheetNames.length > 1 ? "cover" : "ชื่อแพทย์ สมชาย ใจดี";
    ws.getCell("A1").font  = { bold: true };
    ws.getCell("B2").value = "รวมแต้มทั้งหมด";
    ws.getCell("C2").value = 1234.5;
    ws.pageSetup.printArea = "A1:C3";
  });
  wb.views = [{ x: 0, y: 0, width: 10000, height: 20000, firstSheet: 0, activeTab: sheetNames.length - 1, visibility: "visible" }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** What the old extraction produced: one sheet, renamed sheet1.xml, and a
 *  workbook.xml.rels holding nothing but that worksheet. */
export async function damage(input: Buffer, keep: number): Promise<Buffer> {
  const zip  = await JSZip.loadAsync(input);
  const wb   = await zip.file("xl/workbook.xml")!.async("string");
  const tag  = wb.match(/<sheet\s[^>]*>/g)![keep]!;
  const rId  = tag.match(/r:id="([^"]+)"/)![1];
  const rels = await zip.file("xl/_rels/workbook.xml.rels")!.async("string");
  const kept = rels.match(new RegExp(`<Relationship[^>]*Id="${rId}"[^>]*/>`))![0];
  const path = `xl/${kept.match(/Target="([^"]+)"/)![1]}`;

  const out = new JSZip();
  for (const [p, f] of Object.entries(zip.files)) {
    if (f.dir || (p.startsWith("xl/worksheets/sheet") && p !== path)) continue;
    let data: string | Buffer = await f.async("nodebuffer");
    if (p === "xl/workbook.xml") {
      data = wb.replace(/<sheets>[\s\S]*?<\/sheets>/,
        `<sheets>${tag.replace(/r:id="[^"]*"/, 'r:id="rId1"').replace(/sheetId="[^"]*"/, 'sheetId="1"')}</sheets>`);
    } else if (p === "xl/_rels/workbook.xml.rels") {
      data = rels.replace(/<Relationship\s[\s\S]*<\/Relationships>/,
        `${kept.replace(`Id="${rId}"`, 'Id="rId1"').replace(/Target="[^"]*"/, 'Target="worksheets/sheet1.xml"')}</Relationships>`);
    }
    out.file(p === path ? "xl/worksheets/sheet1.xml" : p, data);
  }
  return Buffer.from(await out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}
