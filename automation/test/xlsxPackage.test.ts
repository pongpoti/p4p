import { test } from "node:test";
import assert   from "node:assert/strict";
import ExcelJS  from "exceljs";
import JSZip    from "jszip";
import { packageProblem, repairWorkbookPackage } from "../xlsx-package.js";

// Fixtures are built here, never committed: the damage is recreated exactly
// as the old extractFirstSheetBuffer() did it.

async function workbook(sheetNames: string[]): Promise<Buffer> {
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
async function damage(input: Buffer, keep: number): Promise<Buffer> {
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

async function read(buf: Buffer) {
  const zip = await JSZip.loadAsync(buf);
  const txt = async (p: string) => (await zip.file(p)?.async("string")) ?? "";
  return { zip, wb: await txt("xl/workbook.xml"), rels: await txt("xl/_rels/workbook.xml.rels"), ct: await txt("[Content_Types].xml") };
}

const relTypes = (rels: string) => [...rels.matchAll(/Type="[^"]*\/([^"/]+)"/g)].map((m) => m[1]);

test("a damaged one-sheet copy gets styles, sharedStrings and theme linked again", async () => {
  const broken = await damage(await workbook(["ส.ค.69"]), 0);
  assert.match((await packageProblem(broken)) ?? "", /not linked/);

  const result = await repairWorkbookPackage(broken);
  assert.equal(result.status, "repaired");
  if (result.status !== "repaired") return;
  assert.equal(await packageProblem(result.buffer), null);

  const after = await read(result.buffer);
  for (const t of ["worksheet", "styles", "theme", "sharedStrings"]) assert.ok(relTypes(after.rels).includes(t), `${t} not linked`);

  // The sheet itself is carried over byte-for-byte.
  const before = await JSZip.loadAsync(broken);
  assert.deepEqual(
    await after.zip.file("xl/worksheets/sheet1.xml")!.async("nodebuffer"),
    await before.file("xl/worksheets/sheet1.xml")!.async("nodebuffer"),
  );
});

test("an intact file, and a repaired one, are left alone", async () => {
  assert.equal((await repairWorkbookPackage(await workbook(["ส.ค.69"]))).status, "ok");
  const once = await repairWorkbookPackage(await damage(await workbook(["ส.ค.69"]), 0));
  assert.equal(once.status, "repaired");
  if (once.status === "repaired") assert.equal((await repairWorkbookPackage(once.buffer)).status, "ok");
});

test("leftovers of the dropped sheets are cleared from a damaged multi-sheet copy", async () => {
  const broken = await damage(await workbook(["cover", "ส.ค.69"]), 1);
  const result = await repairWorkbookPackage(broken);
  assert.equal(result.status, "repaired");
  if (result.status !== "repaired") return;
  assert.equal(await packageProblem(result.buffer), null);

  const after = await read(result.buffer);
  // Only the kept sheet's print area survives, renumbered to its new tab 0.
  const names = after.wb.match(/<definedName\s[^>]*>[\s\S]*?<\/definedName>/g) ?? [];
  assert.equal(names.length, 1);
  assert.match(names[0]!, /localSheetId="0"/);
  assert.match(names[0]!, /ส\.ค\.69/);
  assert.doesNotMatch(after.wb, /activeTab="[1-9]/);
  assert.doesNotMatch(after.ct, /sheet2\.xml/, "content type left for a sheet that is gone");
  assert.ok(result.changes.some((c) => /defined name/.test(c)));
});

test("a reference nothing can be matched to is reported, not guessed", async () => {
  const zip = await JSZip.loadAsync(await damage(await workbook(["ส.ค.69"]), 0));
  const wb  = await zip.file("xl/workbook.xml")!.async("string");
  zip.file("xl/workbook.xml", wb.replace("</sheets>", '</sheets><externalReferences><externalReference r:id="rId9"/></externalReferences>'));
  const result = await repairWorkbookPackage(Buffer.from(await zip.generateAsync({ type: "nodebuffer" })));
  assert.equal(result.status, "manual");
});

test("a file that is not a zip is reported as unreadable", async () => {
  assert.equal((await repairWorkbookPackage(Buffer.from("not an xlsx"))).status, "unreadable");
});

/** A workbook as Google Sheets exports it: its round-trip blob xl/metadata,
 *  linked from the rels and named from an <extLst> entry in workbook.xml. */
async function fromGoogleSheets(input: Buffer): Promise<Buffer> {
  const zip  = await JSZip.loadAsync(input);
  const wb   = await zip.file("xl/workbook.xml")!.async("string");
  const rels = await zip.file("xl/_rels/workbook.xml.rels")!.async("string");
  const ct   = await zip.file("[Content_Types].xml")!.async("string");
  zip.file("xl/metadata", Buffer.from([1, 2, 3]));
  zip.file("xl/_rels/workbook.xml.rels", rels.replace("</Relationships>",
    '<Relationship Id="rId9" Type="http://customschemas.google.com/relationships/workbookmetadata" Target="metadata"/></Relationships>'));
  zip.file("xl/workbook.xml", wb.replace("</workbook>",
    '<extLst><ext uri="GoogleSheetsCustomDataVersion1"><go:sheetsCustomData xmlns:go="http://customooxmlschemas.google.com/" r:id="rId9" roundtripDataSignature="x"/></ext></extLst></workbook>'));
  zip.file("[Content_Types].xml", ct.replace("</Types>", '<Override PartName="/xl/metadata" ContentType="application/binary"/></Types>'));
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

test("a damaged copy of a Google Sheets workbook gets its round-trip data linked again", async () => {
  const original = await fromGoogleSheets(await workbook(["ส.ค.69"]));
  assert.equal((await repairWorkbookPackage(original)).status, "ok");

  const result = await repairWorkbookPackage(await damage(original, 0));
  assert.equal(result.status, "repaired");
  if (result.status !== "repaired") return;
  assert.ok(result.changes.includes("linked xl/metadata"));
  const after = await read(result.buffer);
  assert.match(after.rels, /Id="rId9" Type="http:\/\/customschemas\.google\.com\/relationships\/workbookmetadata" Target="metadata"/);
  assert.equal(await packageProblem(result.buffer), null);
});

test("an empty r:id is not treated as a missing link", async () => {
  const zip = await JSZip.loadAsync(await damage(await workbook(["ส.ค.69"]), 0));
  const wb  = await zip.file("xl/workbook.xml")!.async("string");
  zip.file("xl/workbook.xml", wb.replace("</workbook>", '<extLst><ext uri="x"><y:z xmlns:y="urn:y" r:id=""/></ext></extLst></workbook>'));
  const result = await repairWorkbookPackage(Buffer.from(await zip.generateAsync({ type: "nodebuffer" })));
  assert.equal(result.status, "repaired");
});

/** Add a part (with its content type) to a package. */
async function withPart(input: Buffer, part: string, contentType: string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(input);
  zip.file(part, "<x/>");
  const ct = await zip.file("[Content_Types].xml")!.async("string");
  zip.file("[Content_Types].xml", ct.replace("</Types>", `<Override PartName="/${part}" ContentType="${contentType}"/></Types>`));
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

test("threaded-comment authors and customXml items are relinked too", async () => {
  let broken = await damage(await workbook(["ส.ค.69"]), 0);
  broken = await withPart(broken, "xl/persons/person.xml", "application/vnd.ms-excel.person+xml");
  broken = await withPart(broken, "customXml/item1.xml", "application/xml");
  const result = await repairWorkbookPackage(broken);
  assert.equal(result.status, "repaired");
  if (result.status !== "repaired") return;
  const after = await read(result.buffer);
  assert.match(after.rels, /relationships\/person" Target="persons\/person\.xml"/);
  assert.match(after.rels, /relationships\/customXml" Target="\.\.\/customXml\/item1\.xml"/);
  assert.equal(await packageProblem(result.buffer), null);
});

test("a workbook-level part with no known link makes the file manual, not half-repaired", async () => {
  const broken = await withPart(await damage(await workbook(["ส.ค.69"]), 0), "xl/richData/rdrichvalue.xml", "application/vnd.ms-excel.rdrichvalue+xml");
  const result = await repairWorkbookPackage(broken);
  assert.equal(result.status, "manual");
  if (result.status === "manual") assert.match(result.reason, /xl\/richData\/rdrichvalue\.xml/);
});

test("after damage and repair, every other part is byte-identical to the original", async () => {
  const original = await fromGoogleSheets(await workbook(["ส.ค.69"]));
  const result   = await repairWorkbookPackage(await damage(original, 0));
  assert.equal(result.status, "repaired");
  if (result.status !== "repaired") return;
  const before = await JSZip.loadAsync(original);
  const after  = await JSZip.loadAsync(result.buffer);
  const rewritten = new Set(["xl/_rels/workbook.xml.rels", "[Content_Types].xml", "xl/workbook.xml", "xl/calcChain.xml"]);
  for (const [p, f] of Object.entries(before.files)) {
    if (f.dir || rewritten.has(p)) continue;
    assert.deepEqual(await after.file(p)?.async("nodebuffer"), await f.async("nodebuffer"), `${p} changed`);
  }
});
