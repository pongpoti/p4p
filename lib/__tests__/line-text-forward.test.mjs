/**
 * The LINE webhook forwards who sent a text message to the Telegram admin
 * chat as two plain messages: the LINE display name, then the LINE userId.
 *
 * main.ts is loaded in-process with axios replaced by a fake, like
 * server-routes.test.mjs. Only texts that need no LINE SDK reply are sent
 * here (the SDK's own HTTP client is not faked), which is enough: the
 * forward runs the same way for every text.
 */
import { test, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

const LINE_SECRET = "test-line-secret"
Object.assign(process.env, {
  LINE_CHANNEL_SECRET: LINE_SECRET,
  LINE_ACCESS_TOKEN: "test-line-token",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
  ADMIN_LINE_USER_ID: "U" + "a".repeat(32),
  LINE_LOGIN_CHANNEL_SECRET: "test-login-secret",
  TELEGRAM_BOT_TOKEN: "test-bot",
  TELEGRAM_CHAT_ID: "-100123",
})

const TG = "https://api.telegram.org/bottest-bot/sendMessage"
const PROFILE = "https://api.line.me/v2/bot/profile/"
let calls = []
let profile = () => ({ data: { displayName: "นพ.ทดสอบ ใจดี" } })

const fakeAxios = {
  async get(url) {
    calls.push(["get", url])
    if (url.startsWith(PROFILE)) return profile(url)
    throw new Error("unexpected GET " + url)
  },
  async post(url, body) {
    calls.push(["post", url, body])
    if (url === TG) return { data: { ok: true } }
    if (url === "https://api.line.me/v2/bot/chat/loading/start") return { data: {} }
    throw new Error("unexpected POST " + url)
  },
}
const axiosPath = require.resolve("axios", { paths: [repoRoot] })
require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: fakeAxios }

const app = require(resolve(repoRoot, "main.ts"))

let server
let base
before(async () => {
  await new Promise((ok) => { server = app.listen(0, "127.0.0.1", ok) })
  base = "http://127.0.0.1:" + server.address().port
})
after(() => new Promise((ok) => server.close(ok)))
beforeEach(() => {
  calls = []
  profile = () => ({ data: { displayName: "นพ.ทดสอบ ใจดี" } })
})

function webhook(events) {
  const body = JSON.stringify({ destination: "Ux", events })
  const sig = crypto.createHmac("sha256", LINE_SECRET).update(body).digest("base64")
  return fetch(base + "/line", {
    method: "POST",
    headers: { "content-type": "application/json", "x-line-signature": sig },
    body,
  })
}
const text = (t, userId = "U1234") => ({
  type: "message", replyToken: "rt", source: { type: "user", userId },
  message: { type: "text", id: "1", text: t },
})
const telegramTexts = () => calls.filter(([v, u]) => v === "post" && u === TG).map(([, , b]) => b.text)

test("a typed text sends the display name, then the userId, as two plain messages", async () => {
  const r = await webhook([text("สวัสดีครับ", "U1234")])
  assert.equal(r.status, 200)
  assert.deepEqual(telegramTexts(), ["นพ.ทดสอบ ใจดี", "U1234"])
  const sent = calls.filter(([v, u]) => v === "post" && u === TG).map(([, , b]) => b)
  for (const b of sent) {
    assert.equal(b.chat_id, "-100123")
    assert.equal(b.parse_mode, undefined, "plain text, no Markdown/HTML")
  }
  assert.ok(calls.some(([v, u]) => v === "get" && u === PROFILE + "U1234"))
})

test("the message text itself is never sent to Telegram", async () => {
  await webhook([text("เลขบัญชีของผม 123-4-56789")])
  assert.ok(!telegramTexts().some((t) => t.includes("123-4-56789")))
})

test("the name is still followed by the id when LINE refuses the profile", async () => {
  profile = () => { throw Object.assign(new Error("HTTP 404"), { response: { status: 404 } }) }
  const r = await webhook([text("hello", "U777")])
  assert.equal(r.status, 200)
  assert.deepEqual(telegramTexts(), ["(ไม่ทราบชื่อ LINE)", "U777"])
})

test("the upload page's own trigger line is not forwarded", async () => {
  // Not typed by the user, and the upload's result alert already goes out.
  // The lookup it starts is answered by an error here, which is fine: only
  // the Telegram calls are checked.
  await webhook([text("ส่งไฟล์ P4P เดือนตุลาคม 2569")]).catch(() => {})
  assert.deepEqual(telegramTexts(), [])
})

test("stickers, images and postbacks are not forwarded", async () => {
  await webhook([
    { type: "message", replyToken: "a", source: { type: "user", userId: "U1" }, message: { type: "sticker", id: "2" } },
    { type: "message", replyToken: "b", source: { type: "user", userId: "U2" }, message: { type: "image", id: "3" } },
    { type: "postback", replyToken: "c", source: { type: "user", userId: "U3" }, postback: { data: "other" } },
  ])
  assert.deepEqual(telegramTexts(), [])
})
