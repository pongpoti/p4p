import { fileURLToPath } from 'node:url'
import axios from 'axios'
import type { messagingApi } from '@line/bot-sdk'
import { svgToPng } from './render.mjs'
import { COLOR_ARRAY, MONTH_NAMES, MONTH_ITERATOR } from '../src/constants.js'

const TOKEN = process.env.LINE_TOKEN

const API      = 'https://api.line.me'
const DATA_API = 'https://api-data.line.me'
const authHdr  = { Authorization: `Bearer ${TOKEN}` }
const jsonHdr  = { ...authHdr, 'Content-Type': 'application/json' }

const log = (m: string): void => { process.stdout.write(`${m}\n`) }
const ok  = (m: string): void => log(`✓ ${m}`)

// Pull the readable part of an axios (or generic) error out for logging,
// mirroring the original `e.response?.data?.message ?? e.message` — no
// stringify fallback added, so an all-undefined error still logs "undefined"
// exactly as before.
function axiosErrorMessage(err: unknown): string | undefined {
  const e = err as { response?: { data?: { message?: string } }; message?: string }
  return e?.response?.data?.message ?? e?.message
}

// One row of the month-picker's data, as produced by getMonthData() below.
export interface MonthCell {
  name: string
  year: number
  colorHex: string
  colorTw: string
  sheet: string
}

// ── Layout constants — 2500 × 1686 (large, easy to read) ─────────────────────
const COLS   = [{ x: 0, w: 833 }, { x: 833, w: 834 }, { x: 1667, w: 833 }]
const ROW_H  = 620
const ROWS   = [{ y: 0 }, { y: 620 }]
const BACK_Y = 1240
const BACK_H = 446  // 1240 + 446 = 1686 ✓

// "Today" in Asia/Bangkok (UTC+7, no DST) — independent of the host machine's
// timezone. GitHub Actions runners are UTC, so a run near midnight UTC would
// otherwise resolve to the wrong Thai calendar month (e.g. 23:00 UTC on the
// 30th is already the 1st in Bangkok).
function bangkokYearMonth(): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit',
  }).formatToParts(new Date())
  return {
    year:  Number(parts.find((p) => p.type === 'year')!.value),
    month: Number(parts.find((p) => p.type === 'month')!.value) - 1, // 0–11
  }
}

// ── Calculate 6 months for the given JS month index (0–11) ───────────────────
export function getMonthData(monthIndex?: number): MonthCell[] {
  const { year: ceYear, month: bangkokMonth } = bangkokYearMonth()
  if (monthIndex === undefined) monthIndex = bangkokMonth
  const beYear = ceYear + 543
  return MONTH_ITERATOR[monthIndex].map(([mIdx, yOff]) => ({
    name:     MONTH_NAMES[mIdx],
    year:     beYear + yOff,
    colorHex: COLOR_ARRAY[mIdx][1],
    colorTw:  COLOR_ARRAY[mIdx][0],
    sheet:    `${beYear + yOff}_${String(mIdx + 1).padStart(2, '0')}`,
  }))
}

// ── Generate month-picker SVG (2500 × 1686) ──────────────────────────────────
export function generateSVG(months: MonthCell[]): string {
  const cells = months.map((m, i) => {
    const { x, w } = COLS[i % 3]
    const { y }    = ROWS[Math.floor(i / 3)]
    const cx = x + w / 2
    return `
  <rect x="${x}" y="${y}" width="${w}" height="${ROW_H}" fill="${m.colorHex}"/>
  <text x="${cx}" y="${y + 305}" text-anchor="middle"
    font-family="'Noto Sans Thai',sans-serif"
    font-size="120" font-weight="700" fill="#2D2218">${m.name}</text>
  <text x="${cx}" y="${y + 415}" text-anchor="middle"
    font-family="'Noto Sans Thai',sans-serif"
    font-size="78" fill="#2D2218" opacity="0.7">${m.year}</text>`
  }).join('')

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg viewBox="0 0 2500 1686" xmlns="http://www.w3.org/2000/svg">
  ${cells}
  <line x1="833"  y1="0" x2="833"  y2="${BACK_Y}" stroke="#FFFFFF" stroke-width="8"/>
  <line x1="1667" y1="0" x2="1667" y2="${BACK_Y}" stroke="#FFFFFF" stroke-width="8"/>
  <line x1="0" y1="${ROW_H}" x2="2500" y2="${ROW_H}" stroke="#FFFFFF" stroke-width="8"/>
  <rect x="0" y="${BACK_Y}" width="2500" height="${BACK_H}" fill="#4B3D33"/>
  <g transform="translate(420,${BACK_Y + BACK_H / 2})" fill="none" stroke="#FFFFFF"
     stroke-width="16" stroke-linecap="round" stroke-linejoin="round">
    <line x1="62" y1="0" x2="-62" y2="0"/>
    <polyline points="-8,-54 -62,0 -8,54"/>
  </g>
  <text x="1310" y="${BACK_Y + BACK_H / 2 + 38}" text-anchor="middle"
    font-family="'Noto Sans Thai',sans-serif"
    font-size="100" font-weight="700" fill="#FFFFFF">กลับไปเมนูหลัก</text>
</svg>`
}

// ── Build rich menu JSON payload (2500 × 1686) ───────────────────────────────
export function buildMenuPayload(months: MonthCell[]): messagingApi.RichMenuRequest {
  const monthAreas: messagingApi.RichMenuArea[] = months.map((m, i) => ({
    bounds: {
      x:      COLS[i % 3].x,
      y:      ROWS[Math.floor(i / 3)].y,
      width:  COLS[i % 3].w,
      height: ROW_H,
    },
    action: {
      type: 'uri',
      uri:  `https://liff.line.me/2008561527-a0xP1XmY?sheetname=${m.sheet}&color=${m.colorTw}`,
    },
  }))
  return {
    size:        { width: 2500, height: 1686 },
    selected:    true,
    name:        'Month Picker',
    chatBarText: 'เลือกเดือน',
    areas: [
      ...monthAreas,
      {
        bounds: { x: 0, y: BACK_Y, width: 2500, height: BACK_H },
        action: { type: 'richmenuswitch', richMenuAliasId: 'status', data: 'back_to_main' },
      },
    ],
  }
}

// ── Set alias (create or delete-then-create) ──────────────────────────────────
export async function setAlias(aliasId: string, richMenuId: string): Promise<void> {
  try {
    await axios.post(`${API}/v2/bot/richmenu/alias`,
      { richMenuAliasId: aliasId, richMenuId }, { headers: jsonHdr })
    ok(`Alias "${aliasId}" created`)
  } catch {
    await axios.delete(`${API}/v2/bot/richmenu/alias/${aliasId}`, { headers: authHdr })
    await axios.post(`${API}/v2/bot/richmenu/alias`,
      { richMenuAliasId: aliasId, richMenuId }, { headers: jsonHdr })
    ok(`Alias "${aliasId}" updated`)
  }
}

// ── Create + upload a rich menu, return its richMenuId ────────────────────────
export async function createAndUpload(payload: messagingApi.RichMenuRequest, pngBuffer: Buffer): Promise<string> {
  const { data: { richMenuId } } = await axios.post<{ richMenuId: string }>(
    `${API}/v2/bot/richmenu`, payload, { headers: jsonHdr }
  )
  await axios.post(
    `${DATA_API}/v2/bot/richmenu/${richMenuId}/content`,
    pngBuffer,
    { headers: { ...authHdr, 'Content-Type': 'image/png' }, maxBodyLength: Infinity }
  )
  return richMenuId
}

// ── Main (only runs when called directly, not when imported) ─────────────────
if (process.argv[1] === fileURLToPath(import.meta.url)) {

  if (!TOKEN) { console.error('Missing LINE_TOKEN env var'); process.exit(1) }

  let oldId: string | null = null
  try {
    const res = await axios.get<{ richMenuId: string }>(`${API}/v2/bot/richmenu/alias/month-picker`, { headers: authHdr })
    oldId = res.data.richMenuId
    log(`Existing month-picker: ${oldId}`)
  } catch {
    log('No existing month-picker alias — will create fresh')
  }

  const months = getMonthData()
  log(`Month range: ${months.map(m => `${m.name} ${m.year}`).join(' → ')}`)

  log('Rendering SVG → PNG...')
  const pngBuffer = svgToPng(generateSVG(months))
  ok(`PNG ready — ${(pngBuffer.length / 1024).toFixed(1)} KB`)

  log('Creating rich menu...')
  const richMenuId = await createAndUpload(buildMenuPayload(months), pngBuffer)
  ok(`Month-picker created — ${richMenuId}`)

  await setAlias('month-picker', richMenuId)

  if (oldId && oldId !== richMenuId) {
    try {
      await axios.delete(`${API}/v2/bot/richmenu/${oldId}`, { headers: authHdr })
      ok(`Deleted old rich menu ${oldId}`)
    } catch (e) {
      log(`⚠  Could not delete old rich menu: ${axiosErrorMessage(e)}`)
    }
  }

  log('\n─────────────────────────────────────')
  log(`  alias     : month-picker`)
  log(`  richMenuId: ${richMenuId}`)
  log(`  months    : ${months.map(m => m.name).join(', ')}`)
  log('─────────────────────────────────────')
} // end direct-run guard
