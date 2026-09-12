/**
 * Broadcast the feature carousel to ALL followers of the LINE OA.
 * UTF-8 safe: reads the JSON via Node (utf-8) and sends with fetch — do NOT
 * pipe the JSON through PowerShell Get-Content, which mangles Thai to mojibake.
 *
 * Usage:
 *   $env:LINE_ACCESS_TOKEN="<token>"; npx tsx scripts/broadcast-flex.mts [version]
 *
 * version defaults to v1.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { messagingApi } from '@line/bot-sdk'

const __dirname = dirname(fileURLToPath(import.meta.url))

const token = process.env.LINE_ACCESS_TOKEN
const ver   = process.argv[2] ?? 'v1'

if (!token) { console.error('Set LINE_ACCESS_TOKEN'); process.exit(1) }

const jsonPath = join(__dirname, `../assets/cards/feature-carousel.${ver}.flex.json`)
const message: messagingApi.FlexMessage = JSON.parse(readFileSync(jsonPath, 'utf-8'))

const res = await fetch('https://api.line.me/v2/bot/message/broadcast', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
  body: JSON.stringify({ messages: [message] }),
})

if (res.ok) {
  console.log(`✓ broadcast ${ver} carousel to all followers`)
} else {
  console.error('LINE API error:', JSON.stringify(await res.json(), null, 2))
  process.exit(1)
}
