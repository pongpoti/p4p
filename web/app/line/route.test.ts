import crypto from "node:crypto"
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"

const CHANNEL_SECRET = "test-secret"

function sign(body: string): string {
  return crypto.createHmac("sha256", CHANNEL_SECRET).update(body).digest("base64")
}

function postBody(body: string) {
  return new Request("https://example.com/line", {
    method: "POST",
    headers: { "x-line-signature": sign(body) },
    body,
  })
}

describe("LINE webhook file upload handling", () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    process.env.LINE_CHANNEL_SECRET = CHANNEL_SECRET
    process.env.LINE_ACCESS_TOKEN = "test-token"
    vi.resetModules()
  })

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it.each(["image", "video", "audio", "file"])(
    "replies with the menu prompt for a %s message",
    async (messageType) => {
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }))
      global.fetch = fetchMock as unknown as typeof fetch

      const { POST } = await import("./route")

      const body = JSON.stringify({
        events: [
          {
            type: "message",
            replyToken: "reply-token-1",
            message: { type: messageType },
            source: { userId: "U123" },
          },
        ],
      })

      const res = await POST(postBody(body))
      expect(res.status).toBe(200)

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0]!
      expect(url).toBe("https://api.line.me/v2/bot/message/reply")
      const sentBody = JSON.parse((init as RequestInit).body as string)
      expect(sentBody).toEqual({
        replyToken: "reply-token-1",
        messages: [{ type: "text", text: "กรุณาเลือกเมนูเพื่อส่งไฟล์" }],
      })
    },
  )

  it("does not call the LINE API when a file message has no replyToken", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }))
    global.fetch = fetchMock as unknown as typeof fetch

    const { POST } = await import("./route")

    const body = JSON.stringify({
      events: [{ type: "message", message: { type: "image" }, source: { userId: "U123" } }],
    })

    const res = await POST(postBody(body))
    expect(res.status).toBe(200)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("still replies to plain text commands (regression check)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }))
    global.fetch = fetchMock as unknown as typeof fetch

    const { POST } = await import("./route")

    const body = JSON.stringify({
      events: [
        {
          type: "message",
          replyToken: "reply-token-2",
          message: { type: "text", text: "myid" },
          source: { userId: "U999" },
        },
      ],
    })

    const res = await POST(postBody(body))
    expect(res.status).toBe(200)

    // First call is the loading indicator, second is the reply.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [replyUrl, replyInit] = fetchMock.mock.calls[1]!
    expect(replyUrl).toBe("https://api.line.me/v2/bot/message/reply")
    const sentBody = JSON.parse((replyInit as RequestInit).body as string)
    expect(sentBody).toEqual({
      replyToken: "reply-token-2",
      messages: [{ type: "text", text: "U999" }],
    })
  })

  it("ignores unrelated message types like stickers and locations", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }))
    global.fetch = fetchMock as unknown as typeof fetch

    const { POST } = await import("./route")

    const body = JSON.stringify({
      events: [
        { type: "message", replyToken: "rt-a", message: { type: "sticker" }, source: { userId: "U1" } },
        { type: "message", replyToken: "rt-b", message: { type: "location" }, source: { userId: "U2" } },
      ],
    })

    const res = await POST(postBody(body))
    expect(res.status).toBe(200)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
