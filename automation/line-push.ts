/**
 * line-push.js
 *
 * LINE push transport for the worker — the mirror of telegram.js, and the
 * only thing in this pipeline that spends OA message quota.
 *
 * Post-§7.7 that is a much smaller job than it sounds: the common
 * (high-confidence) tier never comes near this file — its receipt is sent by
 * the page itself through liff.sendMessages(), free, as the physician. And on
 * the deferred tier the rule is **push on failure, pull on success**: a
 * success is collected by the physician tapping the postback button the ACK
 * reply already put in their chat (main.js's /line handler), so the only
 * thing worth a push is a terminal failure — rare, and the one case where the
 * physician has something to do about it.
 *
 * No new secret: .github/workflows/send-carousel.yml already resolves
 * LINE_ACCESS_TOKEN || LINE_TOKEN for exactly this API.
 */

const PUSH_URL = "https://api.line.me/v2/bot/message/push";
const TIMEOUT_MS = 10_000;

function token(): string {
  return process.env.LINE_ACCESS_TOKEN || process.env.LINE_TOKEN || "";
}

/**
 * Push up to 5 message objects to one LINE user.
 *
 * Never throws: a push that cannot be delivered (no line_user_id, revoked
 * token, quota exhausted) must not fail the submission that produced it. The
 * caller leaves `notified_at` null instead, so the gap is visible in the
 * queue rather than invisible.
 *
 * @returns true only when LINE accepted the push.
 */
export async function pushLine(to: string | null | undefined, messages: unknown): Promise<boolean> {
  if (!to) {
    console.warn("│        ⚠️  LINE push skipped: physician has no line_user_id");
    return false;
  }
  const accessToken = token();
  if (!accessToken) {
    console.warn("│        ⚠️  LINE push skipped: no LINE_ACCESS_TOKEN/LINE_TOKEN in env");
    return false;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(PUSH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        to,
        messages: Array.isArray(messages) ? messages.slice(0, 5) : [messages],
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.warn(`│        ⚠️  LINE push failed: ${resp.status} ${body.slice(0, 300)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`│        ⚠️  LINE push error: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
