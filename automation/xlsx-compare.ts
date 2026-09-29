/**
 * xlsx-compare.ts
 *
 * Does an archived Drive copy show exactly what the physician emailed?
 *
 * The copy is not expected to be the same FILE. The archive keeps one tab of
 * a multi-tab workbook, the old extraction renamed that tab's part to
 * sheet1.xml, and the repair re-created the workbook links under new ids.
 * What must hold is:
 *
 *   - every part Excel draws from (the sheet, styles, shared strings, theme,
 *     drawings, …) is the physician's, byte for byte;
 *   - nothing the kept tab or the workbook uses was lost;
 *   - the wiring around them (workbook.xml, its rels, content types) says
 *     what the original said, less the tabs that were left out.
 *
 * The only differences tolerated are those: left-out tabs and what only they
 * used, calcChain (Excel rebuilds it), relationship ids, a renamed sheet
 * part, and tab numbering (sheetId, activeTab, localSheetId).
 *
 * Messages never quote file content (sheet names, defined-name formulas,
 * external paths) — they go to public CI logs.
 */

import JSZip from "jszip";
import * as path from "path";
import { packageProblem, parseRels, relsPathOf, workbookPartPath, xmlAttr, xmlUnescape, type Rel } from "./xlsx-package.js";

export type Comparison =
  | { status: "identical" }
  | { status: "same-content"; notes: string[] }
  | { status: "differs"; problems: string[]; notes: string[] };

interface Tab { tag: string; name: string; part: string | null }

interface Pkg {
  parts : Map<string, Buffer>;
  wb    : string;
  rels  : Rel[];
  ct    : string;
  tabs  : Tab[];
}

const WIRING     = new Set(["[Content_Types].xml", "xl/workbook.xml", "xl/_rels/workbook.xml.rels"]);
const SHEET_REL  = /\/(?:worksheet|chartsheet|dialogsheet|xlMacrosheet|xlIntlMacrosheet)$/;
const CALC_CHAIN = /\/calcChain$/;

async function load(buf: Buffer): Promise<Pkg> {
  const zip   = await JSZip.loadAsync(buf);
  const parts = new Map<string, Buffer>();
  for (const [p, f] of Object.entries(zip.files)) if (!f.dir) parts.set(p, await f.async("nodebuffer"));
  const text = (p: string): string => parts.get(p)?.toString("utf8") ?? "";

  const wb   = text("xl/workbook.xml");
  const rels = parseRels(text("xl/_rels/workbook.xml.rels"));
  const byId = new Map(rels.map((r) => [r.id, r]));
  const tabs = (wb.match(/<sheet\s[^>]*>/g) ?? []).map((tag) => {
    const rel = byId.get(xmlAttr(tag, "r:id") ?? "");
    return { tag, name: xmlUnescape(xmlAttr(tag, "name") ?? ""), part: rel && !rel.external ? workbookPartPath(rel.target) : null };
  });
  return { parts, wb, rels, ct: text("[Content_Types].xml"), tabs };
}

function resolve(fromPart: string, target: string): string {
  return target.startsWith("/") ? target.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(fromPart), target));
}

/** Every part of the original the kept tabs or the workbook itself lead to. */
function neededParts(o: Pkg, keptSheetParts: Set<string>): Set<string> {
  const seen  = new Set(["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels"]);
  const queue: string[] = [];
  const add = (p: string): void => { if (!seen.has(p)) { seen.add(p); queue.push(p); } };

  // The package's own rels resolve from the root, not from a part's folder.
  for (const r of parseRels(o.parts.get("_rels/.rels")?.toString("utf8") ?? "")) {
    if (!r.external) add(r.target.startsWith("/") ? r.target.slice(1) : path.posix.normalize(r.target));
  }
  for (const r of o.rels) {
    if (r.external || CALC_CHAIN.test(r.type)) continue;
    const p = workbookPartPath(r.target);
    if (SHEET_REL.test(r.type) && !keptSheetParts.has(p)) continue;
    add(p);
  }
  while (queue.length) {
    const p  = queue.shift()!;
    const rp = relsPathOf(p);
    const x  = o.parts.get(rp);
    if (!x) continue;
    seen.add(rp);
    for (const r of parseRels(x.toString("utf8"))) if (!r.external) add(resolve(p, r.target));
  }
  return seen;
}

/** Multiset difference a − b. */
function minus(a: string[], b: string[]): string[] {
  const left = new Map<string, number>();
  for (const x of b) left.set(x, (left.get(x) ?? 0) + 1);
  return a.filter((x) => {
    const n = left.get(x) ?? 0;
    if (n > 0) { left.set(x, n - 1); return false; }
    return true;
  });
}

/** A start tag's attributes, sorted, minus the ones named. */
function attrsWithout(tag: string, skip: string[]): string {
  return [...tag.matchAll(/\s([\w:]+)="([^"]*)"/g)]
    .filter((m) => !skip.includes(m[1]!))
    .map((m) => `${m[1]}=${m[2]}`)
    .sort()
    .join(" ");
}

interface DefinedName { open: string; body: string; name: string; local: number | null }

function definedNames(wb: string): DefinedName[] {
  return [...wb.matchAll(/<definedName\s[^>]*?(?:\/>|>([\s\S]*?)<\/definedName>)/g)].map((m) => {
    const open  = m[0].slice(0, m[0].indexOf(">") + 1);
    const local = xmlAttr(open, "localSheetId");
    return { open, body: m[1] ?? "", name: xmlAttr(open, "name") ?? "", local: local === null ? null : Number(local) };
  });
}

/** workbook.xml with everything a kept-tabs copy may legitimately change taken out. */
function workbookSettings(wb: string): string[] {
  return wb
    .replace(/<sheets>[\s\S]*?<\/sheets>/, "")
    .replace(/<definedNames>[\s\S]*?<\/definedNames>|<definedNames\s*\/>/, "")
    .replace(/\sr:id="[^"]*"/g, "")
    .replace(/\s(?:activeTab|firstSheet)="[^"]*"/g, "")
    .match(/<[^>]+>|[^<]+/g) ?? [];
}

/** The element names in a list of workbook.xml tokens — safe to log. */
function elementNames(tokens: string[]): string {
  return [...new Set(tokens.map((t) => t.match(/^<\/?([\w:]+)/)?.[1] ?? "text"))].join(", ");
}

/** Every r:id workbook.xml uses outside <sheets>, as "element → link type → part". */
function references(wb: string, rels: Rel[], partName: (p: string) => string | null): string[] {
  const byId = new Map(rels.map((r) => [r.id, r]));
  const rest = wb.replace(/<sheets>[\s\S]*?<\/sheets>/, "");
  return [...rest.matchAll(/<([\w:]+)(?:\s[^>]*?)?\sr:id="([^"]+)"/g)].map((m) => {
    const r = byId.get(m[2]!);
    const where = !r ? "nothing" : r.external ? "external" : (partName(workbookPartPath(r.target)) ?? "a left-out part");
    return `${m[1]} → ${r?.type.split("/").pop() ?? "?"} → ${where}`;
  });
}

function contentTypes(ct: string): { defaults: Map<string, string>; overrides: Map<string, string> } {
  const defaults  = new Map<string, string>();
  const overrides = new Map<string, string>();
  for (const [t] of ct.matchAll(/<Default\s[^>]*>/g)) defaults.set((xmlAttr(t, "Extension") ?? "").toLowerCase(), xmlAttr(t, "ContentType") ?? "");
  for (const [t] of ct.matchAll(/<Override\s[^>]*>/g)) overrides.set((xmlAttr(t, "PartName") ?? "").replace(/^\//, ""), xmlAttr(t, "ContentType") ?? "");
  return { defaults, overrides };
}

/**
 * Compare an archived copy with the file the physician sent.
 *
 *   identical     the same bytes
 *   same-content  everything Excel shows is the original's; `notes` lists
 *                 the tolerated differences (left-out tabs, calcChain, …)
 *   differs       `problems` lists what does not match
 */
export async function compareWithOriginal(copy: Buffer, original: Buffer): Promise<Comparison> {
  if (copy.equals(original)) return { status: "identical" };

  let d: Pkg, o: Pkg;
  try {
    [d, o] = await Promise.all([load(copy), load(original)]);
  } catch (e) {
    return { status: "differs", problems: [`not readable as a zip (${e instanceof Error ? e.message : e})`], notes: [] };
  }
  const problems: string[] = [];
  const notes: string[]    = [];

  // ── 1. Every tab of the copy is one of the original's, byte for byte ───
  const toOrig  = new Map<string, string>();   // copy path → original path, where they differ
  const keptPos: number[] = [];                 // original tab positions, in the copy's tab order
  for (const [i, tab] of d.tabs.entries()) {
    const bytes = tab.part ? d.parts.get(tab.part) : undefined;
    if (!bytes) { problems.push(`tab ${i + 1} has no sheet part`); continue; }
    const hits = o.tabs
      .map((t, j) => ({ t, j }))
      .filter(({ t, j }) => t.part && !keptPos.includes(j) && o.parts.get(t.part)?.equals(bytes));
    const hit = hits.find(({ t }) => t.name === tab.name) ?? hits[0];
    if (!hit) { problems.push(`tab ${i + 1}: sheet content matches no tab of the original`); continue; }
    keptPos.push(hit.j);
    toOrig.set(tab.part!, hit.t.part!);
    toOrig.set(relsPathOf(tab.part!), relsPathOf(hit.t.part!));

    const skip = ["r:id", "sheetId", "state"];
    if (attrsWithout(tab.tag, skip) !== attrsWithout(hit.t.tag, skip)) problems.push(`tab ${i + 1}: name or tab settings differ`);
    if ((xmlAttr(tab.tag, "state") ?? "visible") !== (xmlAttr(hit.t.tag, "state") ?? "visible")) notes.push(`tab ${i + 1} was ${xmlAttr(hit.t.tag, "state")} in the original`);
  }
  const leftOut = o.tabs.map((_, j) => j).filter((j) => !keptPos.includes(j));
  if (leftOut.length) notes.push(`${leftOut.length} other tab(s) left out`);
  if (keptPos.some((p, i) => i > 0 && p < keptPos[i - 1]!)) problems.push("tabs are in a different order");

  const toCopy = new Map([...toOrig].map(([c, orig]) => [orig, c]));
  /** Where an original part lives in the copy, or null if the copy has no such part. */
  const inCopy = (op: string): string | null => {
    const cp = toCopy.get(op) ?? op;
    if (!toCopy.has(op) && toOrig.has(op)) return null;   // that name now holds another tab
    return d.parts.has(cp) ? cp : null;
  };

  // ── 2. Every part the copy carries is the original's, byte for byte ────
  let identicalParts = 0;
  for (const [p, bytes] of d.parts) {
    if (WIRING.has(p)) continue;
    const ob = o.parts.get(toOrig.get(p) ?? p);
    if (!ob) problems.push(`${p} is not in the original`);
    else if (!ob.equals(bytes)) problems.push(`${p} differs from the original`);
    else identicalParts++;
  }
  notes.unshift(`${identicalParts} part(s) byte-identical`);

  // ── 3. Nothing the kept tabs or the workbook use is missing ────────────
  const keptSheetParts = new Set(keptPos.map((j) => o.tabs[j]!.part!));
  const needed = neededParts(o, keptSheetParts);
  let unused = 0;
  for (const op of o.parts.keys()) {
    if (WIRING.has(op) || inCopy(op)) continue;
    if (op === "xl/calcChain.xml") notes.push("calcChain left out (Excel rebuilds it)");
    else if (needed.has(op)) problems.push(`${op} is missing`);
    else if (!/^xl\/(?:worksheets|chartsheets|dialogsheets|macrosheets)\/(?:_rels\/)?[^/]+$/.test(op)) unused++;
  }
  if (unused) notes.push(`${unused} part(s) only the left-out tabs used, left out`);

  // ── 4. Workbook links: the original's, less left-out tabs and calcChain ─
  const linkKey = (r: Rel, part: string | null): string =>
    `${r.type.split("/").pop()} → ${r.external ? `external ${r.target}` : part}`;
  const redact = (k: string): string => k.replace(/→ external .*/, "→ an external target");
  const expected: string[] = [];
  for (const r of o.rels) {
    if (r.external) { expected.push(linkKey(r, null)); continue; }
    const op = workbookPartPath(r.target);
    if (SHEET_REL.test(r.type) && !keptSheetParts.has(op)) continue;
    if (CALC_CHAIN.test(r.type) && !inCopy(op)) continue;
    if (!o.parts.has(op)) { notes.push("the original links a part it does not contain"); continue; }
    expected.push(linkKey(r, toCopy.get(op) ?? op));
  }
  const actual = d.rels.map((r) => linkKey(r, r.external ? null : workbookPartPath(r.target)));
  for (const k of minus(expected, actual)) problems.push(`workbook link missing: ${redact(k)}`);
  for (const k of minus(actual, expected)) problems.push(`workbook link not in the original: ${redact(k)}`);

  const oRefs = references(o.wb, o.rels, (p) => inCopy(p));
  const dRefs = references(d.wb, d.rels, (p) => p);
  if (oRefs.join("\n") !== dRefs.join("\n")) problems.push(`workbook.xml references differ: ${minus(oRefs, dRefs).concat(minus(dRefs, oRefs)).join("; ")}`);

  const problem = await packageProblem(copy);
  if (problem) problems.push(`does not open cleanly: ${problem}`);

  // ── 5. Content types ───────────────────────────────────────────────────
  const oct = contentTypes(o.ct);
  const dct = contentTypes(d.ct);
  const defaults = (m: Map<string, string>) => [...m].map(([k, v]) => `${k}=${v}`).sort().join(" ");
  if (defaults(oct.defaults) !== defaults(dct.defaults)) problems.push("[Content_Types].xml defaults differ");
  const expectedOverrides = new Map<string, string>();
  for (const [op, type] of oct.overrides) {
    const cp = inCopy(op);
    if (cp) expectedOverrides.set(cp, type);
  }
  for (const [cp, type] of expectedOverrides) {
    if (!dct.overrides.has(cp)) problems.push(`content type for ${cp} missing`);
    else if (dct.overrides.get(cp) !== type) problems.push(`content type for ${cp} differs`);
  }
  for (const cp of dct.overrides.keys()) if (!expectedOverrides.has(cp)) problems.push(`content type for ${cp} not in the original`);

  // ── 6. Defined names (print areas, print titles, …) ────────────────────
  const leftOutNames = leftOut.map((j) => o.tabs[j]!.name);
  const nameKey = (n: DefinedName, local: number | null): string =>
    `${attrsWithout(n.open, ["localSheetId"])} @${local ?? "workbook"} ${n.body}`;
  const wantNames: string[] = [];
  const nameOf = new Map<string, string>();
  for (const n of definedNames(o.wb)) {
    let local: number | null = null;
    if (n.local !== null) {
      local = keptPos.indexOf(n.local);
      if (local < 0) continue;                       // scoped to a left-out tab
    } else {
      const body = xmlUnescape(n.body);
      if (leftOutNames.some((s) => body.includes(`${s}!`) || body.includes(`'${s.replace(/'/g, "''")}'!`))) continue;
    }
    const k = nameKey(n, local);
    wantNames.push(k);
    nameOf.set(k, n.name);
  }
  const haveNames = definedNames(d.wb).map((n) => {
    const k = nameKey(n, n.local);
    nameOf.set(k, n.name);
    return k;
  });
  for (const k of minus(wantNames, haveNames)) problems.push(`defined name ${nameOf.get(k)} missing or changed`);
  for (const k of minus(haveNames, wantNames)) problems.push(`defined name ${nameOf.get(k)} not in the original`);

  // ── 7. Everything else in workbook.xml is untouched ────────────────────
  const ow = workbookSettings(o.wb);
  const dw = workbookSettings(d.wb);
  if (ow.join("") !== dw.join("")) {
    problems.push(`workbook.xml settings differ (${elementNames(minus(ow, dw).concat(minus(dw, ow))) || "order"})`);
  }

  return problems.length ? { status: "differs", problems, notes } : { status: "same-content", notes };
}
