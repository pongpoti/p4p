/**
 * The month-picker Flex message the LINE bot replies with on "status".
 *
 * Moved from main.js (createStatusList / createStatusSublist). The JSON shape
 * is reproduced exactly — it is rendered by the LINE client, not by us, and the
 * URLs point at a registered LIFF app, so this is transcription rather than a
 * rewrite. The only change is sourcing months and colours from lib/ instead of
 * src/constants.ts.
 */
import { monthColorHex, MONTH_COLORS } from "../colors"
import { recentMonthKeys, THAI_MONTHS, parseMonthKey } from "../months"

/** The LIFF app registered against /status/ — used by the month buttons. */
const STATUS_LIFF_URL = "https://liff.line.me/2008561527-a0xP1XmY"

function monthButton(key: string) {
  const parsed = parseMonthKey(key)
  if (!parsed) throw new Error(`monthButton: not a month key: ${key}`)
  const name = `${THAI_MONTHS[parsed.month - 1]} ${parsed.beYear}`
  const hex = monthColorHex(parsed.month)
  const tw = MONTH_COLORS[parsed.month - 1]?.tw ?? ""

  return {
    type: "box",
    layout: "horizontal",
    contents: [
      {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: name,
            align: "center",
            size: "lg",
            style: "italic",
            weight: "bold",
          },
        ],
        backgroundColor: hex,
        cornerRadius: "sm",
        borderColor: hex,
        borderWidth: "semi-bold",
        flex: 3,
        paddingAll: "md",
      },
      {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: "คลิก",
            align: "center",
            weight: "bold",
            size: "lg",
            color: "#412D11",
          },
        ],
        backgroundColor: "#f5f5f5",
        cornerRadius: "md",
        offsetEnd: "md",
        borderColor: "#412D11",
        borderWidth: "semi-bold",
        flex: 1,
        paddingAll: "md",
        action: {
          type: "uri",
          label: key,
          uri: `${STATUS_LIFF_URL}?sheetname=${key}&color=${tw}`,
        },
      },
    ],
    paddingBottom: "xxl",
    paddingTop: "xxl",
  }
}

export function createStatusList(now: Date = new Date()) {
  return {
    type: "flex",
    altText: "เลือกเดือนที่ต้องการ",
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "box",
            layout: "vertical",
            contents: [
              {
                type: "text",
                text: "กรุณาเลือกเดือน",
                align: "center",
                color: "#FFFFFF",
                size: "xxl",
                margin: "md",
                offsetBottom: "sm",
                weight: "bold",
              },
              {
                type: "text",
                text: "สามารถดูได้ 6 เดือนย้อนหลัง",
                color: "#ffffa0",
                align: "center",
              },
            ],
          },
        ],
        backgroundColor: "#4B3D33",
        paddingAll: "xxl",
      },
      hero: {
        type: "box",
        layout: "vertical",
        contents: [],
        height: "5px",
        backgroundColor: "#81A7AE",
      },
      body: {
        type: "box",
        layout: "vertical",
        contents: recentMonthKeys(6, now).map(monthButton),
        backgroundColor: "#F5F5F0",
      },
    },
  }
}
