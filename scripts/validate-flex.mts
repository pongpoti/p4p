/**
 * Validate the feature carousel Flex message against LINE's validate API
 * before sending. Unlike the push/broadcast endpoints, /validate/push returns
 * a detailed `details` array describing exactly which property failed
 * validation (missing field, wrong enum value, etc).
 *
 * Usage:
 *   $env:LINE_ACCESS_TOKEN="<token>"; npx tsx scripts/validate-flex.mts [version]
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

const res = await fetch('https://api.line.me/v2/bot/message/validate/push', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
  body: JSON.stringify({ messages: [message] }),
})

if (res.ok) {
  console.log(`✓ ${ver} carousel is a valid push message`)
} else {
  console.error('Validation error:', JSON.stringify(await res.json(), null, 2))
  process.exit(1)
}
