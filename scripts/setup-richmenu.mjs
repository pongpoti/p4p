import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import axios from 'axios'
import { svgToPng } from './render.mjs'
import {
  getMonthData, generateSVG, buildMenuPayload, setAlias, createAndUpload,
} from './update-month-picker.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TOKEN = process.env.LINE_TOKEN
if (!TOKEN) { console.error('Missing LINE_TOKEN env var'); process.exit(1) }

// The /upload/ LIFF app has its own registration (endpoint /upload/, scopes
// profile + openid + chat_message.write, same Login channel as /verify/ —
// see UPLOAD_VIA_LINE_DESIGN.md §13 Phase 0; `openid` is what makes
// getIDToken() work for the opportunistic bind, and `chat_message.write` is
// what lets the page put the receipt in the chat for free).
// Validated HERE, alongside the token
// and before any side effect, not next to the payload that consumes it:
// Step 1 below already creates a month-picker menu and reassigns its alias,
// so a check placed further down would abort halfway, leaving a new picker
// live and the main menu never updated. A dead fourth block pushed to every
// user is worse than no fourth block, so this refuses rather than guesses.
const UPLOAD_LIFF_ID = process.env.UPLOAD_LIFF_ID
if (!UPLOAD_LIFF_ID) {
  console.error(
    'Missing UPLOAD_LIFF_ID env var — the /upload/ LIFF app id.\n' +
    'Register it in the LINE Developers console first (endpoint /upload/,\n' +
    'scopes profile + openid + chat_message.write, same Login channel as\n' +
    '/verify/), then re-run.'
  )
  process.exit(1)
}

const API     = 'https://api.line.me'
const authHdr = { Authorization: `Bearer ${TOKEN}` }
const jsonHdr = { ...authHdr, 'Content-Type': 'application/json' }

const log = (m) => process.stdout.write(`${m}\n`)
const ok  = (m) => log(`✓ ${m}`)

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 1 — Month-picker rich menu (must exist before main menu references it)
// ═══════════════════════════════════════════════════════════════════════════════
log('\n── Step 1: Month-picker (2500×1686) ──────────────────────────')

const months = getMonthData()
log(`Month range: ${months.map(m => `${m.name} ${m.year}`).join(' → ')}`)

log('Rendering month-picker SVG → PNG...')
const pickerPng = svgToPng(generateSVG(months))
ok(`PNG ready — ${(pickerPng.length / 1024).toFixed(1)} KB`)

log('Creating month-picker rich menu...')
const pickerMenuId = await createAndUpload(buildMenuPayload(months), pickerPng)
ok(`Month-picker created — ${pickerMenuId}`)

await setAlias('month-picker', pickerMenuId)

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 2 — Main rich menu (references alias "month-picker" in block 1)
// ═══════════════════════════════════════════════════════════════════════════════
log('\n── Step 2: Main rich menu (2500×1686) ────────────────────────')

log('Rendering main SVG → PNG...')
const svgPath = join(__dirname, '../src/richmenu.svg')
const mainPng = svgToPng(readFileSync(svgPath, 'utf8'))
ok(`PNG ready — ${(mainPng.length / 1024).toFixed(1)} KB`)

const mainPayload = {
  // 2500×1686 ("large"), two rows: the three read-only pages keep row 1 at
  // their original 833×843 bounds — nobody re-learns a menu they use every
  // month — and the new upload action takes all of row 2.
  size:        { width: 2500, height: 1686 },
  selected:    true,
  name:        'Main Menu',
  chatBarText: 'เมนู',
  areas: [
    {
      // Block 1 — Status: switch to month picker
      bounds: { x: 0, y: 0, width: 833, height: 843 },
      action: { type: 'richmenuswitch', richMenuAliasId: 'month-picker', data: 'open_month_picker' },
    },
    {
      // Block 2 — Ranking
      bounds: { x: 833, y: 0, width: 834, height: 843 },
      action: { type: 'uri', uri: 'https://liff.line.me/2008561527-BXrxUUDb' },
    },
    {
      // Block 3 — Person list
      bounds: { x: 1667, y: 0, width: 833, height: 843 },
      action: { type: 'uri', uri: 'https://liff.line.me/2008561527-wyje9amz' },
    },
    {
      // Block 4 — Upload (full width, row 2)
      bounds: { x: 0, y: 843, width: 2500, height: 843 },
      action: { type: 'uri', uri: `https://liff.line.me/${UPLOAD_LIFF_ID}` },
    },
  ],
}

log('Creating main rich menu...')
const mainMenuId = await createAndUpload(mainPayload, mainPng)
ok(`Main menu created — ${mainMenuId}`)

await setAlias('status', mainMenuId)

log('Setting main menu as default...')
const defRes = await axios.post(
  `${API}/v2/bot/user/all/richmenu/${mainMenuId}`, {},
  { headers: jsonHdr }
)
if (defRes.status !== 200) throw new Error(`Set default failed: ${JSON.stringify(defRes.data)}`)
ok('Set as default for all users')

log('\n─────────────────────────────────────')
log(`  Main menu    alias: status        id: ${mainMenuId}`)
log(`  Month picker alias: month-picker  id: ${pickerMenuId}`)
log(`  Block 1 → richmenuswitch → month-picker`)
log(`  Block 4 → uri → liff.line.me/${UPLOAD_LIFF_ID}`)
log(`  Back btn → richmenuswitch → status`)
log('─────────────────────────────────────')
