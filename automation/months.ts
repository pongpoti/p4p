/**
 * months.js
 *
 * Single source of truth for the Thai month lookup tables shared across the
 * automation pipeline (index.js, drive-client.js, scripts/*). These objects had
 * drifted into three identical copies; centralising them keeps a month/folder
 * tweak a one-line edit and prevents the copies from diverging.
 */

// Month number (1–12) → tokens used to detect the month inside a sheet name or
// free text. Longer tokens are listed first so e.g. "มกราคม" matches before the
// shorter "มกรา" / "มกร".
export const MONTH_TOKENS_BY_NUM: Record<number, string[]> = {
  1:  ["มกราคม", "มกรา", "มกร", "มค", "january", "jan"],
  2:  ["กุมภาพันธ์", "กุมภา", "กุมภ", "กพ", "february", "feb"],
  3:  ["มีนาคม", "มีนา", "มีน", "มีค", "march", "mar"],
  4:  ["เมษายน", "เมษา", "เมษ", "เมย", "april", "apr"],
  5:  ["พฤษภาคม", "พฤษภ", "พฤษ", "พค", "may"],
  6:  ["มิถุนายน", "มิถุน", "มิถุ", "มิย", "june", "jun"],
  7:  ["กรกฎาคม", "กรกฎ", "กรก", "กค", "july", "jul"],
  8:  ["สิงหาคม", "สิงหา", "สิงห", "สค", "august", "aug"],
  9:  ["กันยายน", "กันยา", "กันย", "กย", "september", "sep"],
  10: ["ตุลาคม", "ตุลา", "ตุล", "ตค", "october", "oct"],
  11: ["พฤศจิกายน", "พฤศจิ", "พฤศ", "พย", "november", "nov"],
  12: ["ธันวาคม", "ธันวา", "ธันว", "ธค", "december", "dec"],
};

// Month number (1–12) → Drive month-folder name. These must match the folder
// names in Google Drive exactly (e.g. "3 - มีนาคม").
export const MONTH_FOLDER_NAMES: Record<number, string> = {
   1: "1 - มกราคม",
   2: "2 - กุมภาพันธ์",
   3: "3 - มีนาคม",
   4: "4 - เมษายน",
   5: "5 - พฤษภาคม",
   6: "6 - มิถุนายน",
   7: "7 - กรกฎาคม",
   8: "8 - สิงหาคม",
   9: "9 - กันยายน",
  10: "10 - ตุลาคม",
  11: "11 - พฤศจิกายน",
  12: "12 - ธันวาคม",
};
