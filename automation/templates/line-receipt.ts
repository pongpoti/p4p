/**
 * templates/line-receipt.js
 *
 * The worker's LINE Flex bubbles — the counterpart to templates/reply.js and
 * templates/error-reply.js, which do the same job over email.
 *
 * Only the FAILURE bubble lives here, and that is not an oversight: after
 * §7.7 the worker never sends a success receipt. The instant tier's receipt
 * is sent by the page (lib/line-receipt-flex.js via liff.sendMessages), and
 * the deferred tier's success is pulled by the physician tapping the postback
 * button, answered by main.js — also from lib/. A terminal failure is the one
 * thing that pushes (§7.2/§7.4), so it is the one thing this file builds.
 *
 * This is a deliberate second copy of lib/line-receipt-flex.js's failure
 * path rather than an import: automation/ and the root are isolated
 * sub-projects with their own package.json and module format (C8). The two
 * copies are small, and the strings below are the same taxonomy §10 defines
 * once.
 */

const THAI_MONTHS = [
  "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
];

// Month accent colours, index 0 = January — the hero rule matches the month
// tab the receipt's button opens (mirrors src/constants.cjs's COLOR_ARRAY).
const MONTH_ACCENTS = [
  "#ffa2a2", "#ffb86a", "#ffdf20", "#bbf451", "#7bf1a8", "#46ecd5",
  "#53eafd", "#74d4ff", "#8ec5ff", "#a3b3ff", "#c4b4ff", "#f4a8ff",
];

const HEADER_BG_FAIL = "#B03A2E";
const BODY_BG = "#F5F5F0";
const MUTED = "#6E5C49";

/** Thai reason text per error_type — the taxonomy in design §10. */
const ERROR_TEXT: Record<string, string> = {
  wrong_extension: "ไฟล์ที่ส่งไม่ใช่ไฟล์ Excel (.xlsx) กรุณาส่งไฟล์ใหม่",
  temp_file: "ไฟล์ที่ส่งเป็นไฟล์ชั่วคราวของ Excel (~$) กรุณาปิดไฟล์แล้วส่งไฟล์จริงอีกครั้ง",
  file_link: "ระบบได้รับลิงก์ไฟล์แทนไฟล์จริง กรุณาแนบไฟล์ Excel",
  zero_score: "ไม่พบคะแนนรวมในไฟล์ (คะแนนเป็นศูนย์) กรุณาตรวจสอบไฟล์แล้วส่งใหม่",
  wrong_date: "เดือน/ปีในไฟล์ไม่ถูกต้อง กรุณาตรวจสอบแล้วส่งใหม่",
  month_mismatch: "เดือนในไฟล์ไม่ตรงกับเดือนที่เลือกส่ง กรุณาตรวจสอบแล้วส่งใหม่",
  month_not_found: "ไม่พบเดือนที่ท่านเลือกในไฟล์นี้ กรุณาตรวจสอบว่าแนบไฟล์ถูกเดือน และระบุเดือนไว้ในชื่อชีตหรือหัวตารางของไฟล์",
  not_in_roster: "ไม่พบรายชื่อของท่านในทะเบียนแพทย์ของเดือนนี้ กรุณาติดต่อผู้ดูแลระบบ",
  physician_not_found: "ไม่พบชื่อแพทย์ในระบบ กรุณาติดต่อผู้ดูแลระบบ",
  oversize: "ไฟล์มีขนาดใหญ่เกิน 5 MB กรุณาลดขนาดไฟล์แล้วส่งใหม่",
  other: "ระบบไม่สามารถอ่านไฟล์ของท่านได้ กรุณาตรวจสอบไฟล์แล้วส่งใหม่",
};

// A retry button on an unretryable error is worse than no button (§7.4).
const RETRYABLE = new Set([
  "wrong_extension", "temp_file", "month_mismatch", "month_not_found", "zero_score",
  "wrong_date", "oversize", "file_link",
]);

export function errorText(errorType: unknown): string {
  return ERROR_TEXT[errorType as string] ?? ERROR_TEXT.other!;
}

/** "2569_06" -> "มิถุนายน 2569" */
export function displayMonth(monthKey: unknown): string {
  const [year, month] = String(monthKey ?? "").split("_");
  const name = THAI_MONTHS[parseInt(month ?? "", 10) - 1];
  return name ? `${name} ${year}` : String(monthKey ?? "");
}

/**
 * A LINE Flex JSON node. Deliberately typed with `any` values — this is
 * opaque data assembled for the LINE API (and poked into arbitrarily deep by
 * test/lineReceipt.test.ts), not a shape worth forcing a precise type onto.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FlexNode = { [key: string]: any };

/**
 * The month name on a pill of its own accent colour, centred under the title —
 * the same badge lib/line-receipt-flex.js builds, so a failure bubble and a
 * receipt name the month the same way. `flex: 0` keeps the pill the width of
 * its text; the fillers either side are what centre it. Dark text because
 * every accent above is a 300-level pastel.
 */
function monthBadge(monthKey: unknown, accent: string): FlexNode {
  const pill: FlexNode = {
    type: "box",
    layout: "vertical",
    contents: [
      { type: "text", text: displayMonth(monthKey), size: "sm", weight: "bold", color: "#2D2218", align: "center" },
    ],
    backgroundColor: accent,
    cornerRadius: "xl",
    paddingAll: "xs",
    paddingStart: "md",
    paddingEnd: "md",
    flex: 0,
  };
  return {
    type: "box",
    layout: "horizontal",
    contents: [{ type: "filler" }, pill, { type: "filler" }],
  };
}

export interface FailureBubbleOpts {
  monthKey: unknown;
  errorType: string;
  detail?: unknown;
  uploadLiffUrl?: string;
}

/**
 * @param opts.monthKey       e.g. "2569_06"
 * @param opts.errorType      a key of ERROR_TEXT
 * @param opts.detail       extra Thai detail (e.g. both months named)
 * @param opts.uploadLiffUrl the /upload/ LIFF app, for the retry button
 */
export function buildFailureBubble({ monthKey, errorType, detail, uploadLiffUrl }: FailureBubbleOpts): FlexNode {
  const monthIdx = parseInt(String(monthKey ?? "").split("_")[1] ?? "", 10) - 1;
  const accent = MONTH_ACCENTS[monthIdx] ?? "#81A7AE";
  const retryable = RETRYABLE.has(errorType) && Boolean(uploadLiffUrl);

  const bodyContents: FlexNode[] = [
    { type: "text", text: errorText(errorType), size: "sm", color: "#2D2218", wrap: true },
  ];
  if (detail) {
    bodyContents.push({ type: "text", text: String(detail), size: "xs", color: MUTED, wrap: true, margin: "md" });
  }

  const button = retryable
    ? { type: "button", style: "primary", color: HEADER_BG_FAIL, height: "sm", action: { type: "uri", label: "ส่งไฟล์อีกครั้ง", uri: uploadLiffUrl } }
    : { type: "button", style: "secondary", height: "sm", action: { type: "uri", label: "ติดต่อผู้ดูแล", uri: "https://line.me/R/ti/p/@p4pskh" } };

  return {
    type: "flex",
    altText: `ส่งไฟล์ P4P ไม่สำเร็จ — ${errorText(errorType)}`,
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: HEADER_BG_FAIL,
        paddingAll: "xl",
        contents: [
          { type: "text", text: "⚠️ ส่งไฟล์ P4P ไม่สำเร็จ", align: "center", color: "#FFFFFF", size: "xl", weight: "bold", wrap: true, margin: "md", offsetBottom: "sm" },
          monthBadge(monthKey, accent),
        ],
      },
      hero: { type: "box", layout: "vertical", contents: [], height: "5px", backgroundColor: accent },
      body: { type: "box", layout: "vertical", backgroundColor: BODY_BG, paddingAll: "lg", contents: bodyContents },
      footer: { type: "box", layout: "vertical", contents: [button] },
    },
  };
}
