/**
 * zip-guard.ts
 *
 * The worker's zip-bomb check, run on an emailed attachment and on a queued
 * LINE upload (scripts/drain-uploads.ts) before ExcelJS (or JSZip) inflates
 * it. It is the same check the LINE upload path runs in main.ts:
 * lib/p4p-score.ts checkZipSafety, which reads the zip's central directory
 * (entry count and declared uncompressed sizes), then inflates each entry
 * with node:zlib under a byte budget, so a file whose headers understate its
 * size is stopped at the limit rather than inflated in full.
 *
 * Loaded with require, not import: lib/p4p-score.ts is a CommonJS file of
 * the root project (it assigns module.exports), so it has no ES exports for
 * this ESM package to import, and keeping it out of this project's tsc
 * program means automation needs none of the root's node_modules. The check
 * itself uses only Node built-ins, so the always-on workflow's
 * `npm ci` in automation/ is enough; tsx loads the .ts file.
 */

import { createRequire } from "node:module";
import { MAX_XLSX_ZIP_ENTRIES, MAX_XLSX_UNCOMPRESSED_BYTES } from "./config.js";

interface ZipSafetyModule {
  checkZipSafety(buf: Buffer, opts?: { maxEntries?: number; maxUncompressedBytes?: number }): { entryCount: number; uncompressedBytes: number };
}

const require = createRequire(import.meta.url);
const { checkZipSafety } = require("../lib/p4p-score.ts") as ZipSafetyModule;

export interface ZipProblem {
  /** NOT_A_ZIP, ZIP_TOO_MANY_ENTRIES, ZIP_TOO_LARGE, ZIP64_UNSUPPORTED, ZIP_MALFORMED. */
  code: string;
  message: string;
}

/** Null when the attachment is safe to hand to ExcelJS; otherwise why it is not. Never throws. */
export function zipProblem(buffer: Buffer): ZipProblem | null {
  try {
    checkZipSafety(buffer, { maxEntries: MAX_XLSX_ZIP_ENTRIES, maxUncompressedBytes: MAX_XLSX_UNCOMPRESSED_BYTES });
    return null;
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return {
      code   : typeof code === "string" ? code : "ZIP_MALFORMED",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
