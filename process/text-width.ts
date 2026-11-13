/**
 * Width of a line of text as Google Sheets draws it in TH SarabunPSK, read
 * straight from the font files in src/fonts (the same ones the approval PDF
 * embeds). Sheets draws on a canvas at 96 px per inch, so a 16 pt cell is
 * 21.33 px high and a string is as wide as the sum of its glyph advances.
 *
 * Only the tables needed for that are read: head (units per em), hhea and
 * hmtx (advances), cmap (character → glyph). Thai vowel and tone marks have
 * zero advance in this font, so no shaping is needed: on every string of the
 * Aug 2569 SK03 this is within 2 px of Chrome's own measurement (and Pong's
 * screenshot of the sheet).
 */
import * as fs from 'fs';
import * as path from 'path';

const FONT_DIR = path.join(__dirname, '..', 'src', 'fonts');

interface FontMetrics {
  upm: number;
  advances: number[];
  glyphOf: Map<number, number>;
}

function parseFont(buf: Buffer): FontMetrics {
  const numTables = buf.readUInt16BE(4);
  const tables = new Map<string, number>();
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    tables.set(buf.toString('latin1', rec, rec + 4), buf.readUInt32BE(rec + 8));
  }
  const at = (tag: string): number => {
    const off = tables.get(tag);
    if (off == null) throw new Error(`font has no ${tag} table`);
    return off;
  };

  const upm = buf.readUInt16BE(at('head') + 18);
  const numberOfHMetrics = buf.readUInt16BE(at('hhea') + 34);
  const hmtx = at('hmtx');
  const advances: number[] = [];
  for (let i = 0; i < numberOfHMetrics; i++) advances.push(buf.readUInt16BE(hmtx + i * 4));

  // cmap: prefer a Unicode full-repertoire format 12 table, else BMP format 4.
  const cmap = at('cmap');
  const n = buf.readUInt16BE(cmap + 2);
  let fmt12 = -1;
  let fmt4 = -1;
  for (let i = 0; i < n; i++) {
    const rec = cmap + 4 + i * 8;
    const platform = buf.readUInt16BE(rec);
    const encoding = buf.readUInt16BE(rec + 2);
    const sub = cmap + buf.readUInt32BE(rec + 4);
    const format = buf.readUInt16BE(sub);
    if (format === 12 && (platform === 3 || platform === 0)) fmt12 = sub;
    if (format === 4 && ((platform === 3 && encoding === 1) || platform === 0) && fmt4 < 0) fmt4 = sub;
  }
  const glyphOf = new Map<number, number>();
  if (fmt12 >= 0) {
    const groups = buf.readUInt32BE(fmt12 + 12);
    for (let g = 0; g < groups; g++) {
      const rec = fmt12 + 16 + g * 12;
      const start = buf.readUInt32BE(rec);
      const end = buf.readUInt32BE(rec + 4);
      const glyph = buf.readUInt32BE(rec + 8);
      for (let c = start; c <= end && c - start < 0x10000; c++) glyphOf.set(c, glyph + (c - start));
    }
  } else if (fmt4 >= 0) {
    const segX2 = buf.readUInt16BE(fmt4 + 6);
    const ends = fmt4 + 14;
    const starts = ends + segX2 + 2;
    const deltas = starts + segX2;
    const offsets = deltas + segX2;
    for (let s = 0; s < segX2 / 2; s++) {
      const end = buf.readUInt16BE(ends + s * 2);
      const start = buf.readUInt16BE(starts + s * 2);
      const delta = buf.readInt16BE(deltas + s * 2);
      const rangeOffset = buf.readUInt16BE(offsets + s * 2);
      for (let c = start; c <= end && c !== 0xffff; c++) {
        let glyph: number;
        if (rangeOffset === 0) glyph = (c + delta) & 0xffff;
        else {
          const addr = offsets + s * 2 + rangeOffset + (c - start) * 2;
          glyph = buf.readUInt16BE(addr);
          if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
        }
        if (glyph !== 0) glyphOf.set(c, glyph);
      }
    }
  } else {
    throw new Error('font has no usable cmap');
  }
  return { upm, advances, glyphOf };
}

const cache = new Map<string, FontMetrics>();
function font(bold: boolean): FontMetrics {
  const file = bold ? 'THSarabunPSK-Bold.ttf' : 'THSarabunPSK-Regular.ttf';
  let m = cache.get(file);
  if (!m) {
    m = parseFont(fs.readFileSync(path.join(FONT_DIR, file)));
    cache.set(file, m);
  }
  return m;
}

/** CSS pixels per point (Sheets draws at 96 dpi). */
export const PX_PER_PT = 96 / 72;

/** Width in px of one line of `text` at `sizePt`, bold or not, in TH SarabunPSK. */
export function textWidthPx(text: string, sizePt: number, bold = false): number {
  const f = font(bold);
  const fallback = f.upm; // a character the font lacks is drawn in another font: count a full em
  let units = 0;
  for (const ch of text) {
    if (/\p{Cf}/u.test(ch)) continue; // zero-width and other invisible format characters
    const g = f.glyphOf.get(ch.codePointAt(0)!);
    if (g == null) {
      if (/\p{M}/u.test(ch)) continue; // a combining mark draws over the letter before it
      units += fallback;
      continue;
    }
    units += f.advances[Math.min(g, f.advances.length - 1)];
  }
  return (units / f.upm) * sizePt * PX_PER_PT;
}
