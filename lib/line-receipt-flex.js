/**
 * lib/line-receipt-flex.js
 *
 * The LINE Flex receipt for a P4P upload — success, pending and failure —
 * built once and loaded from BOTH runtimes that need it:
 *
 *   • main.js          `require("./lib/line-receipt-flex")` — the /line
 *                      webhook's postback branch (§7.5 steps ②/④) answers
 *                      with these bubbles.
 *   • upload/app.js    `<script src="/lib/line-receipt-flex.js">` — the page
 *                      hands the success bubble to `liff.sendMessages()` so
 *                      the receipt lands in the chat as the physician's own
 *                      message, free (§7.5).
 *
 * Hence the UMD-lite footer: one file, two loaders, no build step. Note this
 * is NOT shared with `automation/` — that is C8's isolation boundary, so the
 * worker keeps its own copy in automation/templates/line-receipt.js.
 *
 * The palette is deliberately the bot's existing one (`createStatusList()` in
 * main.js): #4B3D33 header, #ffffa0 subtitle, month-accent hero rule, #F5F5F0
 * body. A receipt should read as the same bot as the month picker, not a new
 * one (§7.4).
 */
;(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    // Node/CommonJS (main.js): month names and accents come from the same
    // src/constants.cjs the Flex month picker already uses.
    const { COLOR_ARRAY, MONTH_NAMES } = require("../src/constants.cjs")
    module.exports = factory(COLOR_ARRAY, MONTH_NAMES)
  } else {
    // Browser (upload/app.js): assets/shared.js has already published the
    // same two tables on window.P4P.
    const P4P = root.P4P || (root.P4P = {})
    P4P.receipt = factory(P4P.COLOR_ARRAY, P4P.THAI_MONTHS)
  }
})(typeof self !== "undefined" ? self : this, function (COLOR_ARRAY, MONTH_NAMES) {
  "use strict"

  // Abbreviated Thai month names, index 0 = January. A third copy of what
  // assets/shared.js and web/lib/months.ts already hold — kept honest by
  // lib/__tests__/parity.test.js rather than by hoping.
  const THAI_MONTHS_SHORT = [
    "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
    "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.",
  ]

  const HEADER_BG = "#4B3D33"
  const HEADER_BG_FAIL = "#B03A2E"
  const SUBTITLE = "#ffffa0"
  const BODY_BG = "#F5F5F0"
  const LATE_RED = "#B03A2E"
  const MUTED = "#6E5C49"

  // The month picker's own deep link — no new format (§7.4).
  const STATUS_LIFF = "https://liff.line.me/2008561527-a0xP1XmY"

  /** "2569_06" -> { year: "2569", month: 6 } */
  function splitMonthKey(monthKey) {
    const [year, month] = String(monthKey || "").split("_")
    return { year: year || "", month: parseInt(month, 10) || 0 }
  }

  /** "2569_06" -> "มิถุนายน 2569" */
  function displayMonth(monthKey) {
    const { year, month } = splitMonthKey(monthKey)
    const name = MONTH_NAMES[month - 1]
    return name ? name + " " + year : String(monthKey || "")
  }

  /** 1842.5 -> "1,842.50" — the same string buildHtmlReply() puts in the email. */
  function formatScore(score) {
    const n = Number(score)
    if (!isFinite(n)) return "-"
    return n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  }

  /** ISO timestamp -> "5 ก.ค. 69 14:32", in Asia/Bangkok, BE year. */
  function formatSubmittedAt(iso) {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return ""
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Bangkok",
      day: "numeric", month: "numeric", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(d).reduce((acc, p) => { acc[p.type] = p.value; return acc }, {})
    const beShort = String((parseInt(parts.year, 10) + 543) % 100).padStart(2, "0")
    const monthShort = THAI_MONTHS_SHORT[parseInt(parts.month, 10) - 1] || parts.month
    return `${parseInt(parts.day, 10)} ${monthShort} ${beShort} ${parts.hour}:${parts.minute}`
  }

  function accentFor(monthKey) {
    const { month } = splitMonthKey(monthKey)
    const pair = COLOR_ARRAY[month - 1]
    return pair ? pair[1] : "#81A7AE"
  }

  function twClassFor(monthKey) {
    const { month } = splitMonthKey(monthKey)
    const pair = COLOR_ARRAY[month - 1]
    return pair ? pair[0] : ""
  }

  function header(title, subtitle, backgroundColor) {
    return {
      type: "box",
      layout: "vertical",
      contents: [
        {
          type: "text", text: title, align: "center", color: "#FFFFFF",
          size: "xl", weight: "bold", wrap: true, margin: "md", offsetBottom: "sm",
        },
        { type: "text", text: subtitle, align: "center", color: SUBTITLE, size: "sm", wrap: true },
      ],
      backgroundColor,
      paddingAll: "xl",
    }
  }

  function heroRule(color) {
    return { type: "box", layout: "vertical", contents: [], height: "5px", backgroundColor: color }
  }

  function labelValue(label, value) {
    return {
      type: "box",
      layout: "horizontal",
      contents: [
        { type: "text", text: label, size: "sm", color: MUTED, flex: 4 },
        { type: "text", text: value || "-", size: "sm", color: "#2D2218", weight: "bold", flex: 6, wrap: true, align: "end" },
      ],
      margin: "md",
    }
  }

  function statusButton(monthKey) {
    return {
      type: "button",
      style: "primary",
      color: HEADER_BG,
      height: "sm",
      action: {
        type: "uri",
        label: "ดูสถานะการส่ง",
        uri: STATUS_LIFF + "?sheetname=" + encodeURIComponent(monthKey) + "&color=" + encodeURIComponent(twClassFor(monthKey)),
      },
    }
  }

  /**
   * The success receipt (§7.4). Sent by the page via liff.sendMessages() on
   * the high-confidence tier, and by the /line postback branch on the
   * deferred tier once the worker has finished.
   */
  function buildScoreReceipt({ displayName, department, monthKey, score, receivedAt, isLate }) {
    const submitted = formatSubmittedAt(receivedAt)
    const punctuality = isLate ? "เกินกำหนด" : "ตรงเวลา"
    const scoreText = formatScore(score)

    return {
      type: "flex",
      altText: `บันทึกคะแนน P4P ${displayMonth(monthKey)} — ${scoreText}`,
      contents: {
        type: "bubble",
        size: "mega",
        header: header("✅ บันทึกคะแนน P4P แล้ว", "องค์กรแพทย์ โรงพยาบาลสมุทรสาคร", HEADER_BG),
        hero: heroRule(accentFor(monthKey)),
        body: {
          type: "box",
          layout: "vertical",
          backgroundColor: BODY_BG,
          paddingAll: "lg",
          contents: [
            labelValue("ชื่อแพทย์", displayName),
            labelValue("กลุ่มงาน", department),
            labelValue("เดือน / ปี", displayMonth(monthKey)),
            { type: "separator", margin: "lg", color: "#D9D2C5" },
            {
              type: "box",
              layout: "horizontal",
              margin: "lg",
              contents: [
                { type: "text", text: "คะแนนรวม", size: "sm", color: MUTED, flex: 4, gravity: "bottom" },
                { type: "text", text: scoreText, size: "xxl", weight: "bold", color: HEADER_BG, flex: 6, align: "end" },
              ],
            },
            { type: "separator", margin: "lg", color: "#D9D2C5" },
            {
              type: "text",
              margin: "lg",
              size: "xs",
              wrap: true,
              color: isLate ? LATE_RED : MUTED,
              text: submitted ? `ส่งเมื่อ ${submitted} · ${punctuality}` : punctuality,
            },
          ],
        },
        footer: {
          type: "box",
          layout: "vertical",
          spacing: "sm",
          contents: [
            statusButton(monthKey),
            { type: "text", text: "หากส่งไฟล์ใหม่ ระบบจะใช้ไฟล์ล่าสุดแทน", size: "xxs", color: MUTED, align: "center", wrap: true },
          ],
        },
      },
    }
  }

  /**
   * The ACK bubble (§7.5 step ②) and the "still working" answer to a tap
   * (step ④). Both carry the same postback button, so a physician who taps
   * too early simply gets it back and can tap again later.
   */
  function buildPendingBubble({ monthKey, queueId, ack }) {
    return {
      type: "flex",
      altText: ack ? "รับไฟล์แล้ว กำลังตรวจสอบ" : "ยังตรวจสอบไม่เสร็จ",
      contents: {
        type: "bubble",
        size: "kilo",
        header: header(
          ack ? "📥 รับไฟล์แล้ว" : "⏳ ยังตรวจสอบไม่เสร็จ",
          displayMonth(monthKey),
          HEADER_BG,
        ),
        hero: heroRule(accentFor(monthKey)),
        body: {
          type: "box",
          layout: "vertical",
          backgroundColor: BODY_BG,
          paddingAll: "lg",
          contents: [
            {
              type: "text",
              text: ack ? "กำลังตรวจสอบ สักครู่" : "ระบบกำลังประมวลผลไฟล์ของท่าน กดปุ่มด้านล่างเพื่อดูผลอีกครั้ง",
              size: "sm", color: MUTED, wrap: true,
            },
          ],
        },
        footer: {
          type: "box",
          layout: "vertical",
          contents: [
            {
              type: "button",
              style: "primary",
              color: HEADER_BG,
              height: "sm",
              action: { type: "postback", label: "ดูผลคะแนน", data: "p4p_result=" + encodeURIComponent(queueId || ""), displayText: "ดูผลคะแนน" },
            },
          ],
        },
      },
    }
  }

  // Thai reason text per error_type (§10). Keys mirror automation's
  // ALERT_SUBJECTS plus the three an upload can produce.
  const ERROR_TEXT = {
    wrong_extension: "ไฟล์ที่ส่งไม่ใช่ไฟล์ Excel (.xlsx) กรุณาส่งไฟล์ใหม่",
    temp_file: "ไฟล์ที่ส่งเป็นไฟล์ชั่วคราวของ Excel (~$) กรุณาปิดไฟล์แล้วส่งไฟล์จริงอีกครั้ง",
    file_link: "ระบบได้รับลิงก์ไฟล์แทนไฟล์จริง กรุณาแนบไฟล์ Excel",
    zero_score: "ไม่พบคะแนนรวมในไฟล์ (คะแนนเป็นศูนย์) กรุณาตรวจสอบไฟล์แล้วส่งใหม่",
    wrong_date: "เดือน/ปีในไฟล์ไม่ถูกต้อง กรุณาตรวจสอบแล้วส่งใหม่",
    month_mismatch: "เดือนในไฟล์ไม่ตรงกับเดือนที่เลือกส่ง กรุณาตรวจสอบแล้วส่งใหม่",
    not_in_roster: "ไม่พบรายชื่อของท่านในทะเบียนแพทย์ของเดือนนี้ กรุณาติดต่อผู้ดูแลระบบ",
    physician_not_found: "ไม่พบชื่อแพทย์ในระบบ กรุณาติดต่อผู้ดูแลระบบ",
    oversize: "ไฟล์มีขนาดใหญ่เกิน 5 MB กรุณาลดขนาดไฟล์แล้วส่งใหม่",
    other: "ระบบไม่สามารถอ่านไฟล์ของท่านได้ กรุณาตรวจสอบไฟล์แล้วส่งใหม่",
  }

  // A retry button on an unretryable error is worse than no button (§7.4).
  const RETRYABLE = new Set(["wrong_extension", "temp_file", "month_mismatch", "zero_score", "wrong_date", "oversize", "file_link"])

  function errorText(errorType) {
    return ERROR_TEXT[errorType] || ERROR_TEXT.other
  }

  /** The failure bubble (§7.4): same skeleton, red header, reason, one button. */
  function buildFailureBubble({ monthKey, errorType, detail, uploadLiffUrl }) {
    const retryable = RETRYABLE.has(errorType)
    const contents = [
      { type: "text", text: errorText(errorType), size: "sm", color: "#2D2218", wrap: true },
    ]
    if (detail) {
      contents.push({ type: "text", text: String(detail), size: "xs", color: MUTED, wrap: true, margin: "md" })
    }

    const button = retryable && uploadLiffUrl
      ? { type: "button", style: "primary", color: HEADER_BG_FAIL, height: "sm", action: { type: "uri", label: "ส่งไฟล์อีกครั้ง", uri: uploadLiffUrl } }
      : { type: "button", style: "secondary", height: "sm", action: { type: "uri", label: "ติดต่อผู้ดูแล", uri: "https://line.me/R/ti/p/@p4pskh" } }

    return {
      type: "flex",
      altText: "ส่งไฟล์ P4P ไม่สำเร็จ — " + errorText(errorType),
      contents: {
        type: "bubble",
        size: "mega",
        header: header("⚠️ ส่งไฟล์ P4P ไม่สำเร็จ", displayMonth(monthKey), HEADER_BG_FAIL),
        hero: heroRule(accentFor(monthKey)),
        body: { type: "box", layout: "vertical", backgroundColor: BODY_BG, paddingAll: "lg", contents },
        footer: { type: "box", layout: "vertical", contents: [button] },
      },
    }
  }

  return {
    THAI_MONTHS_SHORT,
    displayMonth,
    formatScore,
    formatSubmittedAt,
    errorText,
    buildScoreReceipt,
    buildPendingBubble,
    buildFailureBubble,
  }
})
