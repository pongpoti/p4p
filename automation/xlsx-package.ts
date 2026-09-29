/**
 * xlsx-package.ts
 *
 * Package-level (zip + relationship) handling for the .xlsx copies archived
 * to Drive, and the repair for the copies an earlier extractFirstSheetBuffer()
 * damaged.
 *
 * THE DAMAGE
 * ----------
 * extractFirstSheetBuffer() used to rewrite xl/_rels/workbook.xml.rels with
 * only the worksheet relationship. Excel reaches styles.xml, sharedStrings.xml
 * and the theme solely through that file, so those copies open with every
 * text cell blank and all formatting gone. Google's Drive preview and openpyxl
 * find the same parts by path instead, which is why it went unnoticed.
 *
 * Every part is still inside the zip — only the links are gone — so the
 * repair puts the links back and leaves the sheet itself byte-for-byte alone.
 */

import JSZip from "jszip";
import * as path from "path";

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const SML = "application/vnd.openxmlformats-officedocument.spreadsheetml";

/** One attribute's raw (still XML-escaped) value from a single start tag. */
export function xmlAttr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? m[1]! : null;
}

export function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** A Target from xl/_rels/workbook.xml.rels as a path inside the zip. */
export function workbookPartPath(target: string): string {
  return target.startsWith("/") ? target.slice(1) : path.posix.normalize(`xl/${target}`);
}

/** The relationships part that belongs to a part: a/b.xml → a/_rels/b.xml.rels */
export function relsPathOf(part: string): string {
  return path.posix.join(path.posix.dirname(part), "_rels", `${path.posix.basename(part)}.rels`);
}

/**
 * Workbook-level parts that only xl/_rels/workbook.xml.rels leads Excel to.
 * `all`: every matching part gets its own link (otherwise the lowest-numbered).
 */
const LINKED_PARTS: { type: string; re: RegExp; all?: boolean }[] = [
  { type: `${REL}/styles`,               re: /^xl\/styles\.xml$/ },
  { type: `${REL}/theme`,                re: /^xl\/theme\/theme\d+\.xml$/ },
  { type: `${REL}/sharedStrings`,        re: /^xl\/sharedStrings\.xml$/ },
  { type: `${REL}/sheetMetadata`,        re: /^xl\/metadata\.xml$/ },
  { type: `${REL}/connections`,          re: /^xl\/connections\.xml$/ },
  { type: `${REL}/volatileDependencies`, re: /^xl\/volatileDependencies\.xml$/ },
  // Threaded-comment authors. Found in a damaged February copy; an August
  // one carried three (person.xml, person0.xml, person1.xml), each linked.
  { type: "http://schemas.microsoft.com/office/2017/10/relationships/person", re: /^xl\/persons\/person\d*\.xml$/, all: true },
  { type: `${REL}/customXml`,            re: /^customXml\/item\d+\.xml$/, all: true },
  // WPS Office's own workbook data. Found in a damaged February copy.
  { type: "http://www.wps.cn/officeDocument/2023/relationships/customStorage", re: /^xl\/customStorage\/customStorage\d*\.xml$/ },
];

/**
 * Parts Excel reaches from the workbook rather than from a sheet. One of
 * these left without any link after a repair means the file held something
 * this module does not know how to reconnect — it is reported, not written.
 * (Parts of the sheets the old extraction dropped — drawings, legacy
 * comments, printer settings … — live elsewhere and are harmless orphans.)
 */
const WORKBOOK_LEVEL = /^(?:xl\/(?!comments\d*\.xml$)[^/]+|xl\/(?:persons|richData|externalLinks|pivotCache|slicerCaches|timelineCaches|model|customData|customStorage)\/[^/]+|customXml\/[^/]+)$/;

/** Parts workbook.xml names by r:id; matched back to their files by number. */
const REFERENCED_PARTS = [
  { element: "externalReference", type: `${REL}/externalLink`,         re: /^xl\/externalLinks\/externalLink\d+\.xml$/ },
  { element: "pivotCache",        type: `${REL}/pivotCacheDefinition`, re: /^xl\/pivotCache\/pivotCacheDefinition\d+\.xml$/ },
  // A workbook that started life in Google Sheets carries Google's round-trip
  // blob (xl/metadata, no extension) and names it from an <extLst> entry.
  // About a quarter of the July copies were made from such a template.
  { element: "sheetsCustomData",  type: "http://customschemas.google.com/relationships/workbookmetadata", re: /^xl\/metadata$/ },
];

/** Content type for each relationship type a repair may have to declare. */
const CONTENT_TYPES: Record<string, string> = {
  [`${REL}/worksheet`]:            `${SML}.worksheet+xml`,
  [`${REL}/styles`]:               `${SML}.styles+xml`,
  [`${REL}/theme`]:                "application/vnd.openxmlformats-officedocument.theme+xml",
  [`${REL}/sharedStrings`]:        `${SML}.sharedStrings+xml`,
  [`${REL}/sheetMetadata`]:        `${SML}.sheetMetadata+xml`,
  [`${REL}/connections`]:          `${SML}.connections+xml`,
  [`${REL}/externalLink`]:         `${SML}.externalLink+xml`,
  [`${REL}/pivotCacheDefinition`]: `${SML}.pivotCacheDefinition+xml`,
};

export interface Rel { tag: string; id: string; type: string; target: string; external: boolean }

export function parseRels(xml: string): Rel[] {
  return (xml.match(/<Relationship\s[^>]*>/g) ?? []).map((tag) => ({
    tag,
    id      : xmlAttr(tag, "Id") ?? "",
    type    : xmlAttr(tag, "Type") ?? "",
    target  : xmlAttr(tag, "Target") ?? "",
    external: xmlAttr(tag, "TargetMode") === "External",
  }));
}

function partNumber(p: string): number {
  return Number(p.match(/(\d+)\.xml$/)?.[1] ?? 0);
}

/** Every part some .rels file in the package points at. */
async function relTargets(zip: JSZip): Promise<Set<string>> {
  const out = new Set<string>();
  for (const p of Object.keys(zip.files)) {
    const m = p.match(/^(.*?)_rels\/[^/]*\.rels$/);   // [^/]* — the package's own is just "_rels/.rels"
    if (!m) continue;
    const base = m[1]!.replace(/\/$/, "");           // the source part's folder
    for (const r of parseRels(await zip.file(p)!.async("string"))) {
      if (r.external) continue;
      out.add(r.target.startsWith("/") ? r.target.slice(1) : path.posix.normalize(path.posix.join(base, r.target)));
    }
  }
  return out;
}

/**
 * Every r:id workbook.xml uses (sheets, external links, pivot caches, …).
 * An empty r:id="" can never resolve and was never a link the old extraction
 * removed, so it is not counted.
 */
function referencedIds(wbXml: string): string[] {
  return [...wbXml.matchAll(/\sr:id="([^"]+)"/g)].map((m) => m[1]!);
}

/**
 * Worksheet names in their ORIGINAL tab order, from docProps/app.xml — which
 * the old extraction never touched, so it still lists the sheets it dropped.
 * The first HeadingPairs group is the worksheet count; its label is localised
 * ("Worksheets", "เวิร์กชีต", …) so only its position is relied on.
 */
async function originalSheetNames(zip: JSZip): Promise<string[] | null> {
  const app = await zip.file("docProps/app.xml")?.async("string");
  if (!app) return null;
  const count = Number(app.match(/<HeadingPairs>[\s\S]*?<vt:i4>(\d+)<\/vt:i4>/)?.[1] ?? NaN);
  const titles = app.match(/<TitlesOfParts>[\s\S]*?<\/TitlesOfParts>/)?.[0];
  if (!Number.isInteger(count) || !titles) return null;
  const names = [...titles.matchAll(/<vt:lpstr>([\s\S]*?)<\/vt:lpstr>/g)].map((m) => xmlUnescape(m[1]!));
  return names.length >= count ? names.slice(0, count) : null;
}

/** Tab names in <sheets> order; null when the package has no workbook. */
export async function workbookSheetNames(input: Buffer): Promise<string[] | null> {
  const wb = await (await JSZip.loadAsync(input)).file("xl/workbook.xml")?.async("string");
  if (wb === undefined) return null;
  return (wb.match(/<sheet\s[^>]*>/g) ?? []).map((t) => xmlUnescape(xmlAttr(t, "name") ?? ""));
}

/** Workbook relationships removed along with the sheets that are not kept. */
const DROPPED_REL_TYPE = /\/(?:worksheet|chartsheet|dialogsheet|xlMacrosheet|xlIntlMacrosheet|calcChain)$/;

/**
 * The package with only the tab at `keepPos` (in <sheets> order), the way
 * the archive keeps one month of a multi-tab workbook: every other part is
 * carried over byte for byte. A one-tab workbook comes back unchanged; null
 * when there is no such tab or the package has no workbook.
 */
export async function keepOneSheet(input: Buffer, keepPos: number): Promise<Buffer | null> {
  const origZip  = await JSZip.loadAsync(input);
  const wbFile   = origZip.file("xl/workbook.xml");
  const relsFile = origZip.file("xl/_rels/workbook.xml.rels");
  if (!wbFile || !relsFile) return null;
  const wbXml   = await wbFile.async("string");
  const relsXml = await relsFile.async("string");

  const sheetTags = wbXml.match(/<sheet\s[^>]*>/g) ?? [];
  if (sheetTags.length <= 1) return keepPos === 0 && sheetTags.length === 1 ? input : null;
  const keepTag = sheetTags[keepPos];
  if (!keepTag) return null;

  // Excel reaches styles, sharedStrings and theme ONLY through this rels file.
  // Drop the other SHEETS' relationships and nothing else: an earlier version
  // kept just the one worksheet relationship, and Excel then opened every
  // Drive copy with all text blank and all formatting gone (Google's preview
  // and openpyxl find those parts by path, which is why it went unnoticed).
  // calcChain goes too — it indexes cells on the dropped sheets, and Excel
  // rebuilds it on the next save.
  const rels = (relsXml.match(/<Relationship\s[^>]*>/g) ?? []).map((tag) => ({
    tag,
    id      : xmlAttr(tag, "Id"),
    type    : xmlAttr(tag, "Type") ?? "",
    target  : xmlAttr(tag, "Target") ?? "",
    external: xmlAttr(tag, "TargetMode") === "External",
  }));
  const keepRel = rels.find((r) => r.id === xmlAttr(keepTag, "r:id"));
  if (!keepRel) return null;

  const dropRels  = rels.filter((r) => r !== keepRel && DROPPED_REL_TYPE.test(r.type));
  const dropParts = new Set<string>();
  for (const r of dropRels) {
    if (r.external) continue;
    const part = workbookPartPath(r.target);
    dropParts.add(part);
    dropParts.add(relsPathOf(part));
  }

  const droppedNames = sheetTags
    .filter((_, i) => i !== keepPos)
    .map((t) => xmlUnescape(xmlAttr(t, "name") ?? ""));

  let newWb = wbXml.replace(
    /<sheets>[\s\S]*?<\/sheets>/,
    `<sheets>${keepTag.replace(/\sstate="[^"]*"/, "").replace(/\s*\/?>$/, "/>")}</sheets>`
  );
  // The kept sheet is now tab 0.
  newWb = newWb.replace(/<workbookView\s[^>]*>/g, (t) => t.replace(/\s(?:activeTab|firstSheet)="[^"]*"/g, ""));
  // Sheet-scoped names point by position; global ones may name a dropped
  // sheet. Either kind left dangling makes Excel "repair" the workbook.
  newWb = newWb.replace(/<definedName\s[^>]*>[\s\S]*?<\/definedName>/g, (dn) => {
    const open  = dn.slice(0, dn.indexOf(">") + 1);
    const local = xmlAttr(open, "localSheetId");
    if (local !== null) {
      return Number(local) === keepPos ? dn.replace(/\slocalSheetId="\d+"/, ' localSheetId="0"') : "";
    }
    const body = xmlUnescape(dn.slice(open.length, dn.lastIndexOf("<")));
    const refsDropped = droppedNames.some(
      (n) => body.includes(`${n}!`) || body.includes(`'${n.replace(/'/g, "''")}'!`)
    );
    return refsDropped ? "" : dn;
  });
  newWb = newWb.replace(/<definedNames>\s*<\/definedNames>/, "");

  let newRels = relsXml;
  for (const r of dropRels) newRels = newRels.replace(r.tag, "");

  const outZip = new JSZip();
  for (const [filePath, fileObj] of Object.entries(origZip.files)) {
    if (fileObj.dir || dropParts.has(filePath)) continue;

    let data: string | Buffer;
    if (filePath === "xl/workbook.xml") {
      data = newWb;
    } else if (filePath === "xl/_rels/workbook.xml.rels") {
      data = newRels;
    } else if (filePath === "[Content_Types].xml") {
      // An Override naming a part that is no longer in the package is itself
      // a corruption to Excel.
      data = (await fileObj.async("string")).replace(/<Override\s[^>]*>/g, (tag) =>
        dropParts.has((xmlAttr(tag, "PartName") ?? "").replace(/^\//, "")) ? "" : tag
      );
    } else {
      data = await fileObj.async("nodebuffer");
    }
    // No directory entries — Excel never writes them.
    outZip.file(filePath, data, { createFolders: false });
  }

  return outZip.generateAsync({
    type              : "nodebuffer",
    compression       : "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

export type RepairResult =
  | { status: "ok" }
  | { status: "repaired"; buffer: Buffer; changes: string[] }
  | { status: "manual"; reason: string }
  | { status: "unreadable"; reason: string };

/**
 * Restore the workbook relationships a damaged archive copy lost.
 *
 *   ok          nothing is missing — the file is left as it is
 *   repaired    `buffer` is the fixed file; `changes` says what was done
 *   manual      damaged, but not in a way this can safely undo
 *   unreadable  not an xlsx package at all
 *
 * Only a file that is actually missing a link is rewritten. When it is, the
 * other leftovers of the old extraction go too: calcChain (it indexes the
 * dropped sheets), defined names and tab settings that point at sheets no
 * longer in the file, and content-type entries for parts that are gone.
 */
export async function repairWorkbookPackage(input: Buffer): Promise<RepairResult> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(input);
  } catch (e) {
    return { status: "unreadable", reason: `not a zip archive (${e instanceof Error ? e.message : e})` };
  }
  const wbFile   = zip.file("xl/workbook.xml");
  const relsFile = zip.file("xl/_rels/workbook.xml.rels");
  const ctFile   = zip.file("[Content_Types].xml");
  if (!wbFile || !relsFile || !ctFile) {
    return { status: "unreadable", reason: "missing workbook.xml, its rels, or [Content_Types].xml" };
  }
  let wbXml     = await wbFile.async("string");
  const relsXml = await relsFile.async("string");
  let ctXml     = await ctFile.async("string");

  const parts   = Object.keys(zip.files).filter((p) => !zip.files[p]!.dir);
  const rels    = parseRels(relsXml);
  const relIds  = new Set(rels.map((r) => r.id));
  const refIds  = referencedIds(wbXml);
  const taken   = new Set([...relIds, ...refIds]);
  const added: Rel[] = [];
  const changes: string[] = [];

  let n = 1;
  const freshId = (): string => {
    while (taken.has(`rId${n}`)) n++;
    taken.add(`rId${n}`);
    return `rId${n}`;
  };
  const link = (id: string, type: string, part: string): void => {
    const target = path.posix.relative("xl", part);
    added.push({ tag: `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`, id, type, target, external: false });
    changes.push(`linked ${part}`);
  };

  // 1. Parts only the rels file leads to.
  const linkedTypes   = new Set(rels.map((r) => r.type));
  const linkedTargets = new Set(rels.filter((r) => !r.external).map((r) => workbookPartPath(r.target)));
  for (const spec of LINKED_PARTS) {
    const matching = parts.filter((p) => spec.re.test(p)).sort((a, b) => partNumber(a) - partNumber(b));
    if (spec.all) {
      for (const part of matching) if (!linkedTargets.has(part)) link(freshId(), spec.type, part);
    } else if (!linkedTypes.has(spec.type) && matching[0]) {
      link(freshId(), spec.type, matching[0]);
    }
  }

  // 2. Parts workbook.xml names by an r:id the rels file no longer has. They
  //    were written in reference order, so the Nth reference is file N.
  for (const spec of REFERENCED_PARTS) {
    const refs = [...wbXml.matchAll(new RegExp(`<(?:\\w+:)?${spec.element}\\s[^>]*>`, "g"))]
      .map((m) => xmlAttr(m[0], "r:id") ?? "")
      .filter(Boolean);
    const dangling = refs.filter((id) => !relIds.has(id));
    if (dangling.length === 0) continue;
    const files = parts.filter((p) => spec.re.test(p)).sort((a, b) => partNumber(a) - partNumber(b));
    if (dangling.length !== refs.length || files.length !== refs.length) {
      return { status: "manual", reason: `${refs.length} ${spec.element} reference(s), ${dangling.length} unresolved, ${files.length} matching part(s)` };
    }
    refs.forEach((id, i) => link(id, spec.type, files[i]!));
  }

  // 3. Anything workbook.xml still points at that has no relationship.
  const resolvable = new Set([...relIds, ...added.map((r) => r.id)]);
  const unresolved = [...new Set(refIds.filter((id) => !resolvable.has(id)))];
  if (unresolved.length) {
    return { status: "manual", reason: `workbook.xml refers to ${unresolved.join(", ")} and no part could be matched to it` };
  }

  if (added.length === 0) return { status: "ok" };

  // ── From here the file is being rewritten anyway ──────────────────────
  const drop = new Set<string>();

  // calcChain lists formula cells by sheet — including sheets that were
  // dropped. Excel rebuilds it on the next save.
  const calcChain = "xl/calcChain.xml";
  if (parts.includes(calcChain) && !rels.some((r) => workbookPartPath(r.target) === calcChain)) {
    drop.add(calcChain);
    changes.push("removed stale calcChain.xml");
  }

  // Every workbook-level part must now be reachable from some rels file.
  const reached = await relTargets(zip);
  for (const r of added) reached.add(workbookPartPath(r.target));
  const unlinked = parts.filter((p) => WORKBOOK_LEVEL.test(p) && !drop.has(p) && !reached.has(p) && p !== "[Content_Types].xml");
  if (unlinked.length) {
    return { status: "manual", reason: `no known way to relink ${unlinked.join(", ")}` };
  }

  // The old extraction always kept exactly one sheet, but left sheet-scoped
  // names and tab settings numbered for the original workbook.
  const sheetTags = wbXml.match(/<sheet\s[^>]*>/g) ?? [];
  if (sheetTags.length === 1) {
    const keptName = xmlUnescape(xmlAttr(sheetTags[0]!, "name") ?? "");
    const original = await originalSheetNames(zip);
    const keptPos  = original ? Math.max(0, original.indexOf(keptName)) : 0;
    const dropped  = (original ?? []).filter((s) => s !== keptName);

    let removedNames = 0;
    wbXml = wbXml.replace(/<definedName\s[^>]*>[\s\S]*?<\/definedName>/g, (dn) => {
      const open  = dn.slice(0, dn.indexOf(">") + 1);
      const local = xmlAttr(open, "localSheetId");
      if (local !== null) {
        if (Number(local) === keptPos) return keptPos === 0 ? dn : dn.replace(/\slocalSheetId="\d+"/, ' localSheetId="0"');
        removedNames++;
        return "";
      }
      const body = xmlUnescape(dn.slice(open.length, dn.lastIndexOf("<")));
      if (dropped.some((s) => body.includes(`${s}!`) || body.includes(`'${s.replace(/'/g, "''")}'!`))) {
        removedNames++;
        return "";
      }
      return dn;
    });
    wbXml = wbXml.replace(/<definedNames>\s*<\/definedNames>/, "");
    if (removedNames) changes.push(`removed ${removedNames} defined name(s) pointing at dropped sheets`);

    const views = wbXml.replace(/<workbookView\s[^>]*>/g, (t) => t.replace(/\s(?:activeTab|firstSheet)="[1-9]\d*"/g, ""));
    if (views !== wbXml) changes.push("reset the active tab to the only sheet");
    wbXml = views;
  }

  // Content types: nothing may be declared for a part that is not there, and
  // every linked part needs its type (the fallback "application/xml" would
  // make Excel reject it).
  const finalParts = new Set(parts.filter((p) => !drop.has(p)));
  ctXml = ctXml.replace(/<Override\s[^>]*>/g, (tag) => {
    const part = (xmlAttr(tag, "PartName") ?? "").replace(/^\//, "");
    return finalParts.has(part) ? tag : "";
  });
  const declared = new Set(
    [...ctXml.matchAll(/<Override\s[^>]*>/g)].map((m) => (xmlAttr(m[0], "PartName") ?? "").replace(/^\//, ""))
  );
  const overrides: string[] = [];
  for (const r of [...rels, ...added]) {
    if (r.external) continue;
    const part = workbookPartPath(r.target);
    const type = CONTENT_TYPES[r.type];
    if (!type || declared.has(part) || !finalParts.has(part)) continue;
    overrides.push(`<Override PartName="/${part}" ContentType="${type}"/>`);
    declared.add(part);
  }
  if (overrides.length) ctXml = ctXml.replace("</Types>", `${overrides.join("")}</Types>`);

  const newRels = relsXml.replace("</Relationships>", `${added.map((r) => r.tag).join("")}</Relationships>`);

  const out = new JSZip();
  for (const p of parts) {
    if (!finalParts.has(p)) continue;
    let data: string | Buffer;
    if (p === "xl/workbook.xml") data = wbXml;
    else if (p === "xl/_rels/workbook.xml.rels") data = newRels;
    else if (p === "[Content_Types].xml") data = ctXml;
    else data = await zip.file(p)!.async("nodebuffer");
    out.file(p, data, { createFolders: false });
  }
  const buffer = await out.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });

  const problem = await packageProblem(buffer);
  if (problem) return { status: "manual", reason: `repair did not verify: ${problem}` };
  return { status: "repaired", buffer, changes };
}

/**
 * The checks a repaired file must pass before it may replace the Drive copy:
 * every workbook relationship lands on a real part, every r:id workbook.xml
 * uses resolves, every declared content type names a real part, and styles /
 * sharedStrings / theme — when present — are linked. Null when all hold.
 */
export async function packageProblem(buffer: Buffer): Promise<string | null> {
  const zip   = await JSZip.loadAsync(buffer);
  const parts = new Set(Object.keys(zip.files).filter((p) => !zip.files[p]!.dir));
  const wb    = (await zip.file("xl/workbook.xml")?.async("string")) ?? "";
  const rels  = parseRels((await zip.file("xl/_rels/workbook.xml.rels")?.async("string")) ?? "");
  const ct    = (await zip.file("[Content_Types].xml")?.async("string")) ?? "";

  for (const r of rels) {
    if (!r.external && !parts.has(workbookPartPath(r.target))) return `relationship ${r.id} points at missing ${r.target}`;
  }
  const ids = new Set(rels.map((r) => r.id));
  for (const id of referencedIds(wb)) if (!ids.has(id)) return `workbook.xml refers to unknown ${id}`;
  for (const m of ct.matchAll(/<Override\s[^>]*>/g)) {
    const part = (xmlAttr(m[0], "PartName") ?? "").replace(/^\//, "");
    if (!parts.has(part)) return `[Content_Types].xml declares missing ${part}`;
  }
  const types = new Set(rels.map((r) => r.type));
  for (const spec of LINKED_PARTS.slice(0, 3)) {
    if ([...parts].some((p) => spec.re.test(p)) && !types.has(spec.type)) return `${spec.type.split("/").pop()} is not linked`;
  }
  return null;
}
