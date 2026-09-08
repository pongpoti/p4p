/**
 * Build update-card PNGs and Flex carousel JSON for a release.
 *
 * Usage:
 *   node scripts/build-cards.mjs          ← builds latest (v1)
 *   node scripts/build-cards.mjs v1       ← explicit version
 *   node scripts/build-cards.mjs v2       ← future release
 *
 * Each release lives in scripts/releases/<version>.mjs and outputs to:
 *   assets/cards/<version>/*.png
 *   assets/cards/feature-carousel.<version>.flex.json
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { svgToPng } from './render.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

const LATEST  = 'v1'
const version = process.argv[2] ?? LATEST
const release = await import(`./releases/${version}.mjs`)
const { RELEASE, BASE_URL, ALT_TEXT, svgs, features } = release
// Optional per-release accent for the TEXT area (bullet dot, divider bar,
// "ฟีเจอร์" eyebrow label) — separate from the hero PNGs' own colours, which
// each release's svgs already control directly. Defaults to v1's green so
// any release that doesn't set these (including a v1 rebuild) is unaffected.
const THEME_COLOR       = release.THEME_COLOR ?? '#00C300'
const THEME_LABEL_COLOR = release.THEME_LABEL_COLOR ?? '#00A300'

const OUT = join(__dirname, `../assets/cards/${RELEASE}`)
mkdirSync(OUT, { recursive: true })

// ── Render PNGs ───────────────────────────────────────────────────────────────
for (const { file, svg, width } of svgs) {
  const png = svgToPng(svg, width)
  writeFileSync(join(OUT, file), png)
  console.log(`✓ ${RELEASE}/${file} — ${(png.length / 1024).toFixed(1)} KB`)
}

// ── Build Flex carousel JSON ──────────────────────────────────────────────────
const bulletRow = (text) => ({
  type: 'box', layout: 'baseline', spacing: 'sm', margin: 'md',
  contents: [
    { type: 'text', text: '•', size: 'sm', color: THEME_COLOR, weight: 'bold', flex: 0 },
    { type: 'text', text, size: 'sm', color: '#555555', wrap: true, flex: 1 },
  ],
})

const featureBubble = ({ img, title, bullets }) => ({
  type: 'bubble',
  size: 'mega',
  hero: {
    type: 'image', url: `${BASE_URL}/${img}`,
    size: 'full', aspectRatio: '20:13', aspectMode: 'cover',
  },
  body: {
    type: 'box', layout: 'vertical', paddingAll: '16px', backgroundColor: '#FFFFFF',
    contents: [
      { type: 'text', text: 'ฟีเจอร์', size: 'xs', weight: 'bold', color: THEME_LABEL_COLOR },
      { type: 'text', text: title, size: 'lg', weight: 'bold', color: '#333333', margin: 'sm', wrap: true },
      { type: 'box', layout: 'vertical', contents: [], width: '34px', height: '3px', backgroundColor: THEME_COLOR, cornerRadius: '2px', margin: 'md' },
      ...bullets.map(bulletRow),
    ],
  },
})

const message = {
  type: 'flex',
  altText: ALT_TEXT,
  contents: {
    type: 'carousel',
    contents: [
      {
        type: 'bubble', size: 'mega',
        hero: { type: 'image', url: `${BASE_URL}/cover.png`, size: 'full', aspectRatio: '3:4', aspectMode: 'cover' },
      },
      ...features.map(featureBubble),
    ],
  },
}

const jsonOut = join(__dirname, `../assets/cards/feature-carousel.${RELEASE}.flex.json`)
writeFileSync(jsonOut, JSON.stringify(message, null, 2))
console.log(`✓ feature-carousel.${RELEASE}.flex.json`)
