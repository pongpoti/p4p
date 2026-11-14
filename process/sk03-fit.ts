/**
 * Column widths and header heights for the SK03 sheets (Pong, 2026-11-13:
 * every column as wide as its longest value on one line; a header may take
 * more than one line).
 *
 * Pure functions over a plain grid (what the Sheets API returns as formatted
 * values and fonts), so the sizing can be checked offline:
 *   - a column is as wide as its widest body cell (data rows, totals row,
 *     side panel), and never narrower than the longest word of its header,
 *     so a header wraps between words and never inside one;
 *   - header rows grow when the narrower columns make a header take more
 *     lines (they never shrink);
 *   - a dotted signature line in a merged cell gets as many dots as fit
 *     across the merged columns.
 */
import { textWidthPx, PX_PER_PT } from './text-width';

/** Space Sheets leaves round a cell's text (padding and grid line) plus a small margin. */
export const PAD_X = 12;

/**
 * Column width in Sheets px for text `textPx` wide. The SK03 also goes out as
 * .xlsx (the auditor's email, a download): Google writes a width of px into
 * the file as (px + 1) / 8 characters and Excel draws a character as 7 px
 * (Arial 10, the file's default font), so a column comes out about 1/8
 * narrower in Excel. The width is the larger of what Sheets needs and what
 * leaves Excel 6 px round the text.
 */
export function columnPx(textPx: number): number {
  return Math.max(Math.ceil(textPx + PAD_X), Math.ceil(((textPx + 6) * 8) / 7));
}

/** Room for text in a column `widthPx` wide, in Sheets and in Excel (the inverse of columnPx). */
export function textRoomPx(widthPx: number): number {
  return Math.min(widthPx - PAD_X, (widthPx * 7) / 8 - 6);
}
/** Space above and below a wrapped header. */
export const PAD_Y = 6;
/** Line spacing Sheets uses for wrapped TH SarabunPSK text: 1.18-1.2 em in Pong's screenshot. */
export const LINE_EM = 1.2;

export interface Cell {
  text: string;   // formatted value as shown, '' when empty
  sizePt: number;
  bold: boolean;
}

/** 0-based, inclusive. */
export interface Box { r1: number; c1: number; r2: number; c2: number }

export interface Grid {
  cell(r: number, c: number): Cell | null;
  merges: Box[];
  colPx(c: number): number;
  rowPx(r: number): number;
}

/** Rows × columns whose cells set the column widths. */
export interface Region { rows: [number, number]; cols: number[] }

export interface FitSpec {
  /** Cells that must fit on one line. */
  body: Region[];
  /** Header rows (0-based, inclusive): wrap allowed, heights grow to fit. */
  header: [number, number];
  /** The header row that takes any extra height a taller header needs. */
  flexRow: number;
  /** Columns sized by this spec; others keep their width. */
  cols: number[];
  /** Body cells left to overflow into empty neighbours (notes beside the panel). */
  skip?: Box[];
  /** Columns whose header must stay on one line (the signature column). */
  oneLineHeader?: number[];
  /**
   * Columns at least as wide as this text: pay columns stay wide enough for
   * a month's pay while the budget is still missing (pay shows 0.00 until it
   * is saved; saving it on the dashboard rebuilds the month and fits again).
   */
  floor?: Record<number, { text: string; sizePt: number; bold?: boolean }>;
  /** Rows (0-based) of merged signature lines whose dot leaders are fitted to the merged width. */
  dotRows?: number[];
  /** Title rows (0-based) above the header: a title wider than its merged cell wraps. */
  titleRows?: number[];
}

export interface FitResult {
  widths: Map<number, number>;   // column → px
  heights: Map<number, number>;  // row → px (only rows that grow)
  texts: { r: number; c: number; text: string }[]; // signature lines rewritten
  wraps: { r: number; c: number }[];                // titles set to wrap
}

const inBox = (b: Box, r: number, c: number) => r >= b.r1 && r <= b.r2 && c >= b.c1 && c <= b.c2;

function mergeAt(grid: Grid, r: number, c: number): Box | null {
  return grid.merges.find(m => inBox(m, r, c)) ?? null;
}

/** Width in px of a cell's text on one line (its longest line when it holds line breaks). */
export function cellWidth(cell: Cell): number {
  return Math.max(0, ...cell.text.split('\n').map(line => textWidthPx(line.trim(), cell.sizePt, cell.bold)));
}

const segmenter = new Intl.Segmenter('th', { granularity: 'word' });
const OPENING = /^[([{“‘"']+$/;

/**
 * The pieces a line may break between: Thai words (by the dictionary, as
 * Sheets wraps), with punctuation kept on the word it belongs to (an opening
 * bracket on the next word, anything else on the previous one) and spaces as
 * break points.
 */
export function chunks(line: string): string[] {
  const out: string[] = [];
  let carry = '';      // opening punctuation waiting for its word
  let glue = false;    // the last chunk may take following punctuation
  for (const { segment, isWordLike } of segmenter.segment(line)) {
    if (/^\s+$/.test(segment)) { glue = false; if (carry) { out.push(carry); carry = ''; } continue; }
    if (isWordLike) { out.push(carry + segment); carry = ''; glue = true; continue; }
    if (OPENING.test(segment)) { carry += segment; continue; }
    if (glue && out.length) out[out.length - 1] += segment;
    else carry += segment;
  }
  if (carry) out.push(carry);
  return out;
}

/** Widest piece of a header that must not be split across lines. */
export function longestChunkPx(cell: Cell): number {
  let w = 0;
  for (const line of cell.text.split('\n')) for (const ch of chunks(line)) w = Math.max(w, textWidthPx(ch, cell.sizePt, cell.bold));
  return w;
}

/** Lines a header takes when wrapped at `widthPx` (cell width, padding included). */
export function wrappedLines(cell: Cell, widthPx: number): number {
  const avail = Math.max(1, textRoomPx(widthPx));
  const space = textWidthPx(' ', cell.sizePt, cell.bold);
  let lines = 0;
  for (const raw of cell.text.split('\n')) {
    const line = raw.trim();
    if (!line) { lines++; continue; }
    let n = 1;
    let used = 0;
    // Chunks keep their spacing: a chunk that followed a space adds one.
    const pieces: { w: number; gap: number }[] = [];
    let pos = 0;
    for (const ch of chunks(line)) {
      const at = line.indexOf(ch, pos);
      pieces.push({ w: textWidthPx(ch, cell.sizePt, cell.bold), gap: at > pos ? space : 0 });
      pos = at + ch.length;
    }
    for (const p of pieces) {
      if (used === 0) {
        n += Math.max(0, Math.ceil(p.w / avail) - 1); // a piece wider than the cell breaks inside it
        used = p.w > avail ? p.w % avail : p.w;
      } else if (used + p.gap + p.w <= avail) {
        used += p.gap + p.w;
      } else {
        n++;
        n += Math.max(0, Math.ceil(p.w / avail) - 1);
        used = p.w > avail ? p.w % avail : p.w;
      }
    }
    lines += n;
  }
  return Math.max(1, lines);
}

/**
 * Height in px a header needs at `widthPx`; 0 when it fits on one line (a
 * one-line header already fits the template's row).
 */
export function headerHeightPx(cell: Cell, widthPx: number): number {
  const lines = wrappedLines(cell, widthPx);
  return lines < 2 ? 0 : lines * LINE_EM * cell.sizePt * PX_PER_PT + PAD_Y;
}

/** The text with its longest run of dots shortened, if need be, so the line fits `widthPx`. */
export function fitDots(text: string, widthPx: number, sizePt: number, bold: boolean): string {
  const runs = [...text.matchAll(/\.{10,}/g)];
  if (!runs.length) return text;
  const run = runs.reduce((a, b) => (b[0].length > a[0].length ? b : a));
  const rest = text.slice(0, run.index) + text.slice(run.index! + run[0].length);
  const dot = textWidthPx('.', sizePt, bold);
  const room = textRoomPx(widthPx) - textWidthPx(rest, sizePt, bold);
  const n = Math.min(run[0].length, Math.max(10, Math.floor(room / dot)));
  return text.slice(0, run.index) + '.'.repeat(n) + text.slice(run.index! + run[0].length);
}

/** Widths for `spec.cols`, header heights and fitted signature lines for one sheet. */
export function fitSheet(grid: Grid, spec: FitSpec): FitResult {
  const sized = new Set(spec.cols);
  const widths = new Map<number, number>();
  const want = (c: number, px: number) => {
    if (!sized.has(c)) return;
    widths.set(c, Math.max(widths.get(c) ?? 0, Math.ceil(px)));
  };
  const skipped = (r: number, c: number) => (spec.skip ?? []).some(b => inBox(b, r, c));

  // 1. Body cells: one line each. Merged cells span columns; they are left out.
  for (const { rows: [r1, r2], cols } of spec.body) {
    for (let r = r1; r <= r2; r++) for (const c of cols) {
      const cell = grid.cell(r, c);
      if (!cell || !cell.text.trim() || skipped(r, c)) continue;
      const m = mergeAt(grid, r, c);
      if (m && (m.c1 !== m.c2 || m.r1 !== m.r2)) continue;
      want(c, columnPx(cellWidth(cell)));
    }
  }
  for (const [c, f] of Object.entries(spec.floor ?? {})) want(Number(c), columnPx(textWidthPx(f.text, f.sizePt, f.bold ?? false)));

  // 2. Headers: no column narrower than the longest word of its header
  //    (or the whole header, for the signature column). A header merged
  //    across columns needs the columns' total; any shortfall is shared.
  const [h1, h2] = spec.header;
  const headers: { box: Box; cell: Cell }[] = [];
  for (let r = h1; r <= h2; r++) for (const c of spec.cols) {
    const cell = grid.cell(r, c);
    if (!cell || !cell.text.trim()) continue;
    const m = mergeAt(grid, r, c);
    if (m && (m.r1 !== r || m.c1 !== c)) continue; // not the merge's top-left cell
    headers.push({ box: m ?? { r1: r, c1: c, r2: r, c2: c }, cell });
  }
  const colW = (c: number) => widths.get(c) ?? grid.colPx(c);
  const spanW = (b: Box) => { let w = 0; for (let c = b.c1; c <= b.c2; c++) w += colW(c); return w; };
  const colsOf = (b: Box) => Array.from({ length: b.c2 - b.c1 + 1 }, (_, k) => b.c1 + k).filter(c => sized.has(c));
  const widen = (b: Box, px: number) => { const cols = colsOf(b); for (const c of cols) widths.set(c, Math.ceil(colW(c) + px / cols.length)); };
  // Single columns first, then merged ones (they share what is still short).
  const single = headers.filter(h => h.box.c1 === h.box.c2);
  const merged = headers.filter(h => h.box.c1 !== h.box.c2);
  for (const { box, cell } of single) {
    const oneLine = (spec.oneLineHeader ?? []).includes(box.c1);
    want(box.c1, columnPx(oneLine ? cellWidth(cell) : longestChunkPx(cell)));
  }
  for (const { box, cell } of merged) {
    const short = columnPx(longestChunkPx(cell)) - spanW(box);
    if (short > 0 && colsOf(box).length) widen(box, short);
  }
  // A header wraps into as many lines as the template's header rows hold;
  // when it needs more, its column widens (rather than the rows growing),
  // at most to the width that puts it on one line.
  for (const { box, cell } of [...single, ...merged]) {
    if (!colsOf(box).length) continue;
    let room = 0;
    for (let r = box.r1; r <= box.r2; r++) room += grid.rowPx(r);
    const oneLineW = columnPx(cellWidth(cell));
    const w0 = spanW(box);
    let w = w0;
    while (w < oneLineW && headerHeightPx(cell, w) > room) w += 2;
    if (w > w0) widen(box, w - w0);
  }

  // 3. Header heights at the new widths (a safety net: the widening above
  //    normally leaves nothing to do): single-row headers first, then any
  //    header spanning rows gets what it still lacks from the flex row.
  const heights = new Map<number, number>();
  const rowH = (r: number) => heights.get(r) ?? grid.rowPx(r);
  const grow = (r: number, px: number) => { if (px > rowH(r)) heights.set(r, Math.ceil(px)); };
  for (const { box, cell } of headers.filter(h => h.box.r1 === h.box.r2)) grow(box.r1, headerHeightPx(cell, spanW(box)));
  for (const { box, cell } of headers.filter(h => h.box.r1 !== h.box.r2)) {
    let have = 0;
    for (let r = box.r1; r <= box.r2; r++) have += rowH(r);
    const short = headerHeightPx(cell, spanW(box)) - have;
    const flex = box.r1 <= spec.flexRow && spec.flexRow <= box.r2 ? spec.flexRow : box.r2;
    if (short > 0) grow(flex, rowH(flex) + short);
  }

  // 4. Dotted signature lines across merged cells.
  const texts: FitResult['texts'] = [];
  for (const r of spec.dotRows ?? []) {
    for (const m of grid.merges.filter(b => b.r1 === r)) {
      const cell = grid.cell(m.r1, m.c1);
      if (!cell || !/\.{10,}/.test(cell.text)) continue;
      const fitted = fitDots(cell.text, spanW(m), cell.sizePt, cell.bold);
      if (fitted !== cell.text) texts.push({ r: m.r1, c: m.c1, text: fitted });
    }
  }
  // 5. A title wider than the table wraps, and its row grows to the lines.
  const wraps: FitResult['wraps'] = [];
  for (const r of spec.titleRows ?? []) {
    for (const m of grid.merges.filter(b => b.r1 === r && b.r2 === r)) {
      const cell = grid.cell(m.r1, m.c1);
      if (!cell || cellWidth(cell) <= textRoomPx(spanW(m))) continue;
      wraps.push({ r: m.r1, c: m.c1 });
      grow(r, headerHeightPx(cell, spanW(m)));
    }
  }
  return { widths, heights, texts, wraps };
}

// ─── The SK03 sheets ──────────────────────────────────────────────
// Row numbers in the arguments are the sheet's own (1-based); specs are 0-based.

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, k) => a + k);
const PAY_FLOOR = { text: '00,000.00', sizePt: 16 }; // one person's month of pay

/**
 * Staff or intern sheet. Body: data rows and the totals row (`totalRow`),
 * columns A..V (staff) or A..T (intern), and the side panel (staff X/Y rows
 * 8-23, intern V/W rows 8-16). The panel's notes under it (X25:X26) overflow
 * to the right and are left out; the spacer columns keep their width.
 */
export function overallSpec(isIntern: boolean, firstRow: number, totalRow: number): FitSpec {
  const last = isIntern ? 19 : 21;                       // T or V
  const panel = isIntern ? [21, 22] : [23, 24];          // V/W or X/Y
  const panelRows: [number, number] = isIntern ? [7, 15] : [7, 22];
  return {
    body: [
      { rows: [firstRow - 1, totalRow - 1], cols: range(0, last) },
      { rows: panelRows, cols: panel },
    ],
    header: [4, 6],
    flexRow: 5,
    cols: [...range(0, last), ...panel],
    floor: {
      13: PAY_FLOOR,
      14: PAY_FLOOR,
      [panel[1]]: { text: isIntern ? '000,000.00' : '0,000,000.00', sizePt: 16 },
    },
    dotRows: [totalRow + 3, totalRow + 4],
    titleRows: [0, 1, 2],
  };
}

/** งบรายสาขา sheet (A..Q, the 15,000-cap columns O..Q included): department rows, the total row and the J26 check cell. */
export function budgetSpec(firstRow: number, totalRow: number): FitSpec {
  return {
    body: [
      { rows: [firstRow - 1, totalRow - 1], cols: range(0, 16) },
      { rows: [totalRow + 1, totalRow + 1], cols: [9] },
    ],
    header: [firstRow - 3, firstRow - 2],
    flexRow: firstRow - 2,
    cols: range(0, 16),
    floor: {
      8: { text: '000,000.00', sizePt: 14, bold: true },
      11: { text: '0,000.00', sizePt: 14 },
      12: { text: '0,000,000', sizePt: 14, bold: true },
      13: { text: '0,000.00', sizePt: 14, bold: true },
      14: { text: '0,000.00', sizePt: 14, bold: true },
      16: { text: '0,000.00', sizePt: 14 },
    },
    titleRows: [0, 1, 2],
  };
}

/**
 * Department sheet: data rows from 6 to `lastRow`, columns A..I. The
 * signature column (H) is as wide as its header on one line, so there is
 * room to sign; the signature lines under the table (rows lastRow+3 and
 * lastRow+5) get as many dots as fit.
 */
export function deptSpec(lastRow: number): FitSpec {
  return {
    body: [{ rows: [5, lastRow - 1], cols: range(0, 8) }],
    header: [3, 4],
    flexRow: 4,
    cols: range(0, 8),
    oneLineHeader: [7],
    floor: { 5: PAY_FLOOR, 6: PAY_FLOOR },
    dotRows: [lastRow + 2, lastRow + 4],
    titleRows: [0, 1, 2],
  };
}
