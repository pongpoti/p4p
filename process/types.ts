/**
 * process/types.ts
 *
 * Small type-only shapes shared across process.ts, report.ts, and
 * preprocess-drive.ts. Kept in a dedicated file rather than lib.ts because
 * lib.ts's runtime export uses `export = {...}` (to keep its compiled output
 * byte-for-byte the same CommonJS `module.exports = {...}` as the original
 * lib.js), and TypeScript does not allow an `export =` assignment to
 * coexist with other top-level `export` declarations (interfaces included)
 * in the same file. This file has no runtime export at all — every
 * declaration below is erased by tsc — so importing from it (via
 * `import type { ... } from './types'`) has zero effect on emitted JS.
 */

import type { drive_v3 } from 'googleapis';

/** One candidate month in the 6-month scan window used by
 *  getTargetMonths()/getTargetMonth() across process.ts, report.ts, and
 *  preprocess-drive.ts. */
export interface MonthInfo {
  key: string;    // e.g. "2568_12" (BE year "_" zero-padded month)
  beYear: number;
  month: number;  // 1-12
}

/** A Google Drive file/folder listing entry, as returned by
 *  drive.files.list() (via lib.ts's driveListAll/listFolders/listExcelFiles). */
export type DriveFile = drive_v3.Schema$File;
