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

/** A physician's formatted report, and the same report corrected on a Drive
 *  copy that opened blank: numbers and formulas only, no text, no formatting. */

const days = ["D5", "E5", "F5"];

/** The day-number header every report has, which a correction never changes. */
function dayHeader(ws: ExcelJS.Worksheet): void {
  for (let d = 1; d <= 10; d++) ws.getCell(4, 3 + d).value = d;
}

export async function formatted(tab = "ก.ค.69", month = "กรกฎาคม"): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(tab);
  ws.mergeCells("A1:G1");
  ws.getCell("A1").value = `ชื่อแพทย์ สมหญิง ใจดี เดือน ${month} 2569`;
  ws.getCell("A1").font  = { bold: true, size: 16 };
  dayHeader(ws);
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

export async function blankCorrection(extra: [string, number][] = []): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("ก.ค.69");
  ws.mergeCells("A1:G1");
  dayHeader(ws);
  ws.getCell("D5").value = 3;
  ws.getCell("F5").value = 4;                                      // E5 removed
  ws.getCell("G5").value = { formula: "SUM(D5:F5)", result: 7 };
  ws.getCell("G7").value = { formula: "G5*5", result: 35 };
  for (const [addr, v] of extra) ws.getCell(addr).value = v;
  return Buffer.from(await wb.xlsx.writeBuffer());
}
