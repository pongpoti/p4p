/**
 * One-off: push the latest feature carousel to a single LINE user.
 * Usage:
 *   $env:LINE_ACCESS_TOKEN="<token>"; $env:LINE_USER_ID="<Uxxxxxxx>"; npx tsx scripts/send-test-flex.mts [version]
 *
 * version defaults to v1.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { messagingApi } from '@line/bot-sdk'

const __dirname = dirname(fileURLToPath(import.meta.url))

const token  = process.env.LINE_ACCESS_TOKEN
const userId = process.env.LINE_USER_ID
const ver    = process.argv[2] ?? 'v1'

if (!token)  { console.error('Set LINE_ACCESS_TOKEN'); process.exit(1) }
if (!userId) { console.error('Set LINE_USER_ID');      process.exit(1) }

// A LINE userId is always "U" + 32 hex chars. The push endpoint returns the
// same bare {"message":"Failed to send messages"} for a malformed/unknown
// "to" as it does for other failures (LINE won't confirm/deny a user's
// existence), so check the shape here to distinguish the two.
if (!/^U[0-9a-f]{32}$/i.test(userId)) {
  console.error(`LINE_USER_ID does not look like a valid userId (got ${userId.length} chars: "${userId.slice(0, 4)}...${userId.slice(-4)}"). Expected "U" + 32 hex characters — copy it from your LINE Official Account Manager > chat with the bot, or from a webhook event's source.userId, not a display name or LINE ID.`)
  process.exit(1)
}

const jsonPath = join(__dirname, `../assets/cards/feature-carousel.${ver}.flex.json`)
const message: messagingApi.FlexMessage = JSON.parse(readFileSync(jsonPath, 'utf-8'))

const res = await fetch('https://api.line.me/v2/bot/message/push', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
  body: JSON.stringify({ to: userId, messages: [message] }),
})

const body = await res.json()
if (res.ok) {
  console.log(`✓ sent ${ver} carousel to ${userId}`)
} else {
  console.error(`LINE API error (HTTP ${res.status}, request-id ${res.headers.get('x-line-request-id')}):`, JSON.stringify(body, null, 2))
  process.exit(1)
}
