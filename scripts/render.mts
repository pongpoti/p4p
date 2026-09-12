import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fontDir = join(__dirname, '../src/fonts')

// IMPORTANT — load fonts by FILE PATH, not buffer.
//
// resvg-js 2.6.2 silently ignores `fontBuffers` for glyph selection: with
// buffers, it never actually matched "Noto Sans Thai" and instead relied on
// whatever Thai font fontconfig happened to expose. On a dev machine with a
// system Thai font that looked fine; on GitHub Actions runners (no system
// Thai font) every Thai glyph rendered as a tofu box (▯). Passing the same
// files via `fontFiles` loads them into resvg's font database correctly, so
// the embedded Noto Sans Thai is actually used. Combined with
// loadSystemFonts:false this is fully deterministic — output depends only on
// these repo fonts, identical in every environment.
const fontFiles = [
  join(fontDir, 'NotoSansThai-Regular.ttf'),
  join(fontDir, 'NotoSansThai-Bold.ttf'),
]

// Render an SVG string to a PNG Buffer at the given width (height follows viewBox).
// NOTE: resvg-js 2.6.2 ignores `fitTo` when custom fonts are supplied, so we
// set the output size by writing explicit width/height onto the root <svg>; the
// viewBox keeps the original coordinate system.
export function svgToPng(svg: string, width = 2500): Buffer {
  const vb = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)
  if (vb) {
    const height = Math.round((width * Number(vb[2])) / Number(vb[1]))
    svg = svg.replace('<svg ', `<svg width="${width}" height="${height}" `)
  }
  const resvg = new Resvg(svg, {
    background: 'rgba(255,255,255,0)',
    font: {
      fontFiles,
      defaultFontFamily: 'Noto Sans Thai',
      loadSystemFonts: false,
    },
  })
  return resvg.render().asPng()
}
