import { test } from "node:test";
import assert   from "node:assert/strict";
import JSZip    from "jszip";
import { compareWithOriginal } from "../xlsx-compare.js";
import { repairWorkbookPackage } from "../xlsx-package.js";
import { extractFirstSheetBuffer } from "../index.js";
import { damage, workbook } from "./fixtures.js";

/** Rewrite one part of a package. */
async function edit(input: Buffer, part: string, fn: (s: string) => string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(input);
  zip.file(part, fn(await zip.file(part)!.async("string")));
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

async function repaired(input: Buffer): Promise<Buffer> {
  const r = await repairWorkbookPackage(input);
  assert.equal(r.status, "repaired");
  return (r as { buffer: Buffer }).buffer;
}

test("the same bytes are identical", async () => {
  const original = await workbook(["ส.ค.69"]);
  assert.deepEqual(await compareWithOriginal(original, original), { status: "identical" });
});

test("today's extraction of a two-tab workbook shows the same content", async () => {
  const original = await workbook(["cover", "ส.ค.69"]);
  const result   = await compareWithOriginal((await extractFirstSheetBuffer(original))!, original);
  assert.equal(result.status, "same-content", JSON.stringify(result));
  assert.ok(result.status === "same-content" && result.notes.includes("1 other tab(s) left out"));
});

test("a repaired copy of the old extraction shows the same content, renamed tab and all", async () => {
  for (const tabs of [["ส.ค.69"], ["cover", "ส.ค.69"]]) {
    const original = await workbook(tabs);
    const result   = await compareWithOriginal(await repaired(await damage(original, tabs.length - 1)), original);
    assert.equal(result.status, "same-content", `${tabs.length} tab(s): ${JSON.stringify(result)}`);
  }
});

test("a damaged copy that was never repaired is caught", async () => {
  const original = await workbook(["ส.ค.69"]);
  const result   = await compareWithOriginal(await damage(original, 0), original);
  assert.equal(result.status, "differs");
  if (result.status !== "differs") return;
  for (const t of ["styles", "theme", "sharedStrings"]) {
    assert.ok(result.problems.some((p) => p.startsWith(`workbook link missing: ${t} `)), `${t} not reported`);
  }
});

test("a changed colour, a changed cell and a lost print area are each caught", async () => {
  const original = await workbook(["ส.ค.69"]);
  const copy     = await repaired(await damage(original, 0));

  const recoloured = await compareWithOriginal(await edit(copy, "xl/styles.xml", (s) => s.replace("<b/>", "<i/>")), original);
  assert.ok(recoloured.status === "differs" && recoloured.problems.includes("xl/styles.xml differs from the original"));

  const retyped = await compareWithOriginal(await edit(copy, "xl/worksheets/sheet1.xml", (s) => s.replace("<v>1234.5</v>", "<v>1234</v>")), original);
  assert.ok(retyped.status === "differs" && retyped.problems.some((p) => p.includes("matches no tab of the original")));

  const noPrintArea = await compareWithOriginal(await edit(copy, "xl/workbook.xml", (s) => s.replace(/<definedNames>[\s\S]*<\/definedNames>/, "")), original);
  assert.ok(noPrintArea.status === "differs" && noPrintArea.problems.some((p) => p.includes("_xlnm.Print_Area")), JSON.stringify(noPrintArea));
});

test("a part the kept tab uses going missing is caught", async () => {
  const original = await workbook(["ส.ค.69"]);
  const zip      = await JSZip.loadAsync(await repaired(await damage(original, 0)));
  zip.remove("xl/sharedStrings.xml");
  const result = await compareWithOriginal(Buffer.from(await zip.generateAsync({ type: "nodebuffer" })), original);
  assert.ok(result.status === "differs" && result.problems.includes("xl/sharedStrings.xml is missing"), JSON.stringify(result));
});

test("a reference written as the element's first attribute is still followed", async () => {
  const original = await workbook(["ส.ค.69"]);
  const withRef  = async (buf: Buffer, id: string) => edit(buf, "xl/workbook.xml", (s) => s.replace("</sheets>", `</sheets><externalReferences><externalReference r:id="${id}"/></externalReferences>`));
  const zipOf    = async (buf: Buffer) => {
    const zip = await JSZip.loadAsync(buf);
    zip.file("xl/externalLinks/externalLink1.xml", "<externalLink/>");
    return zip;
  };
  const link = (id: string, target: string) =>
    `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${target}"/></Relationships>`;

  const o = await zipOf(await withRef(original, "rId90"));
  o.file("xl/_rels/workbook.xml.rels", (await o.file("xl/_rels/workbook.xml.rels")!.async("string")).replace("</Relationships>", link("rId90", 'externalLink" Target="externalLinks/externalLink1.xml')));
  // The copy's reference lands on styles instead.
  const c = await JSZip.loadAsync(await withRef(original, "rId91"));
  c.file("xl/externalLinks/externalLink1.xml", "<externalLink/>");
  c.file("xl/_rels/workbook.xml.rels", (await c.file("xl/_rels/workbook.xml.rels")!.async("string")).replace("</Relationships>", link("rId91", 'styles" Target="styles.xml')));

  const result = await compareWithOriginal(
    Buffer.from(await c.generateAsync({ type: "nodebuffer" })),
    Buffer.from(await o.generateAsync({ type: "nodebuffer" })),
  );
  assert.ok(result.status === "differs" && result.problems.some((p) => p.startsWith("workbook.xml references differ")), JSON.stringify(result));
});
