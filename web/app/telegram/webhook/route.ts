import { NextResponse } from "next/server"
import { SUPABASE_URL, serverEnv } from "@/lib/config"
import { validWebhookSecret } from "@/lib/telegram/auth"

export const runtime = "nodejs"

/**
 * Receives Telegram's "callback_query" webhook when an admin taps the
 * approve/reject buttons on an access-request alert.
 *
 * Uses the Supabase SERVICE ROLE key to call the approve/reject RPC — that key
 * never leaves the server.
 */
async function telegram(method: string, body: unknown): Promise<void> {
  const token = serverEnv.telegramBotToken()
  if (!token) return
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    })
    console.log(`[tg-webhook] telegram.${method} ${response.status}`)
  } catch (err) {
    console.error(`[tg-webhook] telegram.${method} FAILED:`, err)
  }
}

interface CallbackQuery {
  id: string
  data?: string
  message?: { chat: { id: number }; message_id: number; text?: string }
}

export async function POST(request: Request) {
  // See lib/telegram/auth.ts. Rejects when the secret is unset, not just when
  // it mismatches. Log LENGTHS only, never the values — a length mismatch is a
  // strong sign of a copy-paste truncation between where the secret was set
  // and where it was registered with setWebhook.
  const received = (request.headers.get("x-telegram-bot-api-secret-token") ?? "").trim()
  if (!validWebhookSecret(received)) {
    const expectedLen = (serverEnv.telegramWebhookSecret() ?? "").trim().length
    console.log(
      `[tg-webhook] REJECTED: secret mismatch. received len=${received.length} ` +
        `expected len=${expectedLen} (configured=${expectedLen > 0})`,
    )
    return new NextResponse(null, { status: 401 })
  }

  let callback: CallbackQuery | undefined
  try {
    callback = ((await request.json()) as { callback_query?: CallbackQuery }).callback_query
  } catch {
    return new NextResponse(null, { status: 200 })
  }
  if (!callback?.data) {
    console.log("[tg-webhook] no callback_query.data in body")
    return new NextResponse(null, { status: 200 })
  }

  const [action, token] = String(callback.data).split("|")
  // Log only a token prefix — it's a single-use approve/reject token, but
  // there's no reason to put the full value in the logs.
  console.log(
    `[tg-webhook] action: ${action} token: ${token ? token.slice(0, 8) + "…" : token}`,
  )
  if (!token || (action !== "appr" && action !== "rej")) {
    console.log("[tg-webhook] REJECTED: unparseable callback_data")
    return new NextResponse(null, { status: 200 })
  }

  const serviceKey = serverEnv.supabaseServiceRoleKey()
  try {
    if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set")
    const fn = action === "appr" ? "approve_access_request" : "reject_access_request"
    const rpc = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_token: token }),
      signal: AbortSignal.timeout(8000),
    })
    if (!rpc.ok) throw new Error(`RPC ${rpc.status}`)
    const ok = (await rpc.json()) === true

    await telegram("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: ok
        ? action === "appr"
          ? "อนุมัติแล้ว"
          : "ปฏิเสธคำขอแล้ว"
        : "คำขอนี้ถูกดำเนินการไปแล้ว หรือไม่พบข้อมูล",
    })

    if (ok && callback.message) {
      const suffix = action === "appr" ? "\n\n✅ อนุมัติแล้ว" : "\n\n❌ ปฏิเสธแล้ว"
      await telegram("editMessageText", {
        chat_id: callback.message.chat.id,
        message_id: callback.message.message_id,
        text: (callback.message.text ?? "") + suffix,
        reply_markup: { inline_keyboard: [] },
      })
    }
  } catch (err) {
    console.error("[tg-webhook] RPC call FAILED:", err)
    await telegram("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "เกิดข้อผิดพลาด กรุณาลองใหม่",
    })
  }

  // Respond only after ALL Telegram/Supabase calls finish. Vercel's serverless
  // runtime can freeze the function the instant a response is sent — an early
  // ack let the platform kill answerCallbackQuery/editMessageText before they
  // completed, which is why the button spinner would time out with no
  // confirmation ever showing.
  console.log("[tg-webhook] handler complete, responding 200")
  return new NextResponse(null, { status: 200 })
}
