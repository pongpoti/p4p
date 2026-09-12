/**
 * process/lib.ts
 *
 * Shared helpers used by both process.ts (merge + SK03 pipeline) and
 * report.ts (missing-submission tracker). Previously each script carried its
 * own near-identical copy of every function below; a fix applied to one copy
 * (e.g. the Drive query-string quote-escaping in uploadFileToDrive) had no
 * way to reach the other, so the two scripts silently drifted apart. This
 * module is now the single source of truth for the pieces that ARE meant to
 * behave identically — anything that legitimately differs between the two
 * scripts (e.g. their getTargetMonths() window) intentionally stays local.
 */

import type { drive_v3 } from 'googleapis';

// require(...) is kept exactly as in the original .js (not converted to
// `import`) so this stays a plain CommonJS module at runtime — the
// `as typeof import(...)` cast only adds compile-time types and is erased
// by tsc; it does not change what actually runs.
const { google } = require('googleapis') as typeof import('googleapis');

// ═══════════════════════════════════════════════════════════════════
//  Logging / control flow
// ═══════════════════════════════════════════════════════════════════
type LogLevel = 'info' | 'warn';

function log(msg: string, level: LogLevel = 'info'): void {
  (level === 'warn' ? console.error : console.log)((level === 'warn' ? '⚠  ' : '') + msg);
}

/** ms delay */
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/**
 * Retry an async fn on Google quota (429) or server (5xx) errors.
 * Exponential backoff starting at 3 s, capped at 60 s.
 */
async function withRetry<T>(fn: () => Promise<T>, maxRetries: number = 7): Promise<T> {
  let delay = 3000;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const status: number = err?.response?.status ?? err?.status ?? 0;
      const msg: string    = err?.message ?? '';
      const isQuota  = status === 429 || msg.includes('Quota exceeded') || msg.includes('RESOURCE_EXHAUSTED');
      const isServer = status >= 500 && status < 600;
      if ((isQuota || isServer) && attempt < maxRetries) {
        const wait = delay + Math.random() * 1000;
        log(`  [Retry] ${isQuota ? 'Quota' : 'Server'} — waiting ${(wait / 1000).toFixed(1)}s (attempt ${attempt + 1}/${maxRetries})`, 'warn');
        await sleep(wait);
        delay = Math.min(delay * 2, 60000);
      } else {
        throw err;
      }
    }
  }
  // Unreachable at runtime — the final loop iteration always either returns
  // or throws (see the `else throw err` branch above) — but TS can't prove
  // that for a runtime-bounded `for` loop. This keeps the declared
  // `Promise<T>` return type honest without changing the (never-taken)
  // fall-through behaviour of the original .js.
  throw new Error('withRetry: exhausted retries without a result');
}

// ═══════════════════════════════════════════════════════════════════
//  String helpers
// ═══════════════════════════════════════════════════════════════════
function stripExt(filename: string): string { return filename.replace(/\.(xlsx|xls)$/i, '').trim(); }
function normaliseName(name?: string | null): string { return (name ?? '').trim().replace(/\s+/g, ' '); }

// ═══════════════════════════════════════════════════════════════════
//  Google API clients
// ═══════════════════════════════════════════════════════════════════
function createAuth() {
  const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return auth;
}

function createDriveClient(): drive_v3.Drive {
  return google.drive({ version: 'v3', auth: createAuth() });
}

// ═══════════════════════════════════════════════════════════════════
//  Google Drive helpers
// ═══════════════════════════════════════════════════════════════════
async function driveListAll(
  drive: drive_v3.Drive,
  params: drive_v3.Params$Resource$Files$List
): Promise<drive_v3.Schema$File[]> {
  const items: drive_v3.Schema$File[] = [];
  let pageToken: string | undefined;
  do {
    const res = await withRetry(() => drive.files.list({ ...params, pageToken }));
    items.push(...(res.data.files ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return items;
}

async function listFolders(drive: drive_v3.Drive, parentId: string): Promise<drive_v3.Schema$File[]> {
  return driveListAll(drive, {
    q: `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'nextPageToken, files(id, name)', pageSize: 100,
  });
}

async function listExcelFiles(drive: drive_v3.Drive, folderId: string): Promise<drive_v3.Schema$File[]> {
  const mimes = [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
  ].map(m => `mimeType='${m}'`).join(' or ');
  return driveListAll(drive, {
    q: `'${folderId}' in parents and (${mimes}) and trashed=false`,
    fields: 'nextPageToken, files(id, name)', pageSize: 100,
  });
}

export = {
  log, sleep, withRetry,
  stripExt, normaliseName,
  createAuth, createDriveClient,
  driveListAll, listFolders, listExcelFiles,
};
