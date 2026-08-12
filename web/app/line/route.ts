import crypto from "node:crypto"
import { NextResponse } from "next/server"
import { serverEnv } from "@/lib/config"
import { createStatusList } from "@/lib/line/flex"
import { adminKeyUsable, signAdminToken } from "@/lib/admin/tokens"

export const runtime = "nodejs"

/**
 * The LINE bot webhook.
 *
 * `line.middleware(config)` from @line/bot-sdk is Express-shaped and does not
 * survive the move, so the signature check is done directly: HMAC-SHA256 of the
 * RAW body with the channel secret, compared against x-line-signature. The body
 * must be read as text BEFORE parsing — re-serialising parsed JSON would not
 * reproduce the exact bytes LINE signed.
 */
function validSignature(rawBody: string, signature: string | null): boolean {
  const secret = serverEnv.lineChannelSecret()
  if (!secret || !signature) return false
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("base64")
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

interface LineEvent {
  type?: string
  replyToken?: string
  message?: { type?: string; text?: string }
  source?: { userId?: string }
}

async function lineApi(path: string, body: unknown): Promise<void> {
  const token = serverEnv.lineAccessToken()
  if (!token) return
  try {
    await fetch(`https://api.line.me/v2/bot/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    })
  } catch (err) {
    console.error(`[line] ${path} failed:`, err)
  }
}

async function handleEvent(event: LineEvent): Promise<void> {
  if (event.type !== "message" || event.message?.type !== "text") return

  if (event.source?.userId) {
    await lineApi("chat/loading/start", { chatId: event.source.userId })
  }

  const message = (event.message.text ?? "").trim().toLowerCase()
  const replyToken = event.replyToken
  if (!replyToken) return

  if (message === "status") {
    await lineApi("message/reply", { replyToken, messages: [createStatusList()] })
    return
  }

  if (message === "myid") {
    await lineApi("message/reply", {
      replyToken,
      messages: [{ type: "text", text: event.source?.userId ?? "" }],
    })
    return
  }

  if (message === "admin") {
    // Silent no-op for anyone else — never confirm or deny that "admin" is a
    // recognised command, so this cannot be used to probe for the admin's
    // identity.
    if (event.source?.userId !== serverEnv.adminLineUserId()) return
    // signAdminToken throws when the signing secrets are missing. Tell the
    // admin instead of letting it reject the whole webhook batch.
    if (!adminKeyUsable()) {
      await lineApi("message/reply", {
        replyToken,
        messages: [{ type: "text", text: "ระบบผู้ดูแลปิดใช้งานชั่วคราว: ไม่ได้ตั้งค่า secret บนเซิร์ฟเวอร์" }],
      })
      return
    }
    const exp = Math.floor(Date.now() / 1000) + 600 // 10 minutes
    const url = `${serverEnv.adminBaseUrl()}/admin/login?token=${signAdminToken("login", exp)}`
    await lineApi("message/reply", {
      replyToken,
      messages: [{ type: "text", text: `ลิงก์เข้าสู่ระบบผู้ดูแล (ใช้ได้ 10 นาที)\n${url}` }],
    })
  }
}

export async function POST(request: Request) {
  const rawBody = await request.text()
  if (!validSignature(rawBody, request.headers.get("x-line-signature"))) {
    return new NextResponse("bad signature", { status: 401 })
  }

  let events: LineEvent[] = []
  try {
    events = ((await JSON.parse(rawBody)) as { events?: LineEvent[] }).events ?? []
  } catch {
    return NextResponse.json({ ok: true })
  }

  try {
    await Promise.all(events.map(handleEvent))
  } catch (err) {
    console.error("[line] handler failed:", err)
    return new NextResponse("error", { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
