/**
 * Build update-card PNGs and Flex carousel JSON for a release.
 *
 * Usage:
 *   npx tsx scripts/build-cards.mts          ← builds latest (v1)
 *   npx tsx scripts/build-cards.mts v1       ← explicit version
 *   npx tsx scripts/build-cards.mts v2       ← future release
 *
 * Each release lives in scripts/releases/<version>.mts and outputs to:
 *   assets/cards/<version>/*.png
 *   assets/cards/feature-carousel.<version>.flex.json
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import type { messagingApi } from '@line/bot-sdk'
import { svgToPng } from './render.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Shape of a scripts/releases/<version>.mts module, as consumed here. Kept
// local (rather than imported from a releases file) since either release
// module is loaded dynamically below and neither is a fixed dependency of
// this script.
interface SvgSpec {
  file: string
  width: number
  svg: string
}

interface FeatureSpec {
  img: string
  title: string
  bullets: string[]
}

interface ReleaseModule {
  RELEASE: string
  BASE_URL: string
  ALT_TEXT: string
  THEME_COLOR?: string
  THEME_LABEL_COLOR?: string
  svgs: SvgSpec[]
  features: FeatureSpec[]
}

const LATEST  = 'v1'
const version = process.argv[2] ?? LATEST
const release = (await import(`./releases/${version}.mjs`)) as ReleaseModule
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
// Each URL below gets a content-hash query string (same trick main.js's
// stampAssets() uses for <script src>, see its own comment for the incident
// that motivated it): LINE fetches these images once per push and caches
// them by URL indefinitely. Without a hash, re-running this script to fix a
// card and re-sending the SAME test push shows the OLD image — confirmed
// live (2026-09-08): a badge-position fix was pushed, deployed, and still
// didn't appear on a fresh test send because the URL hadn't changed. A
// bare filename is stable across edits; the hash isn't.
const hashes: Record<string, string> = {}
for (const { file, svg, width } of svgs) {
  const png = svgToPng(svg, width)
  writeFileSync(join(OUT, file), png)
  hashes[file] = createHash('sha1').update(png).digest('hex').slice(0, 8)
  console.log(`✓ ${RELEASE}/${file} — ${(png.length / 1024).toFixed(1)} KB`)
}
const urlFor = (file: string): string => `${BASE_URL}/${file}?v=${hashes[file]}`

// ── Build Flex carousel JSON ──────────────────────────────────────────────────
const bulletRow = (text: string): messagingApi.FlexBox => ({
  type: 'box', layout: 'baseline', spacing: 'sm', margin: 'md',
  contents: [
    { type: 'text', text: '•', size: 'sm', color: THEME_COLOR, weight: 'bold', flex: 0 },
    { type: 'text', text, size: 'sm', color: '#555555', wrap: true, flex: 1 },
  ],
})

const featureBubble = ({ img, title, bullets }: FeatureSpec): messagingApi.FlexBubble => ({
  type: 'bubble',
  size: 'mega',
  hero: {
    type: 'image', url: urlFor(img),
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

const message: messagingApi.FlexMessage = {
  type: 'flex',
  altText: ALT_TEXT,
  contents: {
    type: 'carousel',
    contents: [
      {
        type: 'bubble', size: 'mega',
        hero: { type: 'image', url: urlFor('cover.png'), size: 'full', aspectRatio: '3:4', aspectMode: 'cover' },
      },
      ...features.map(featureBubble),
    ],
  },
}

const jsonOut = join(__dirname, `../assets/cards/feature-carousel.${RELEASE}.flex.json`)
writeFileSync(jsonOut, JSON.stringify(message, null, 2))
console.log(`✓ feature-carousel.${RELEASE}.flex.json`)
