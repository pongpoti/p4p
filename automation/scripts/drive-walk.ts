/**
 * scripts/drive-walk.ts
 *
 * What the archive maintenance scripts share: an authorised Google client,
 * retries, a small worker pool, and the walk over
 *   P4P root / <year> / <month> / <physician file>.
 *
 * On GitHub Actions the logs of this public repository are public, so files
 * are identified by month + a short hash of the file ID, never by the
 * physician name that is the Drive filename. Run locally to see names.
 */

import { google, type drive_v3 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { createHash } from "crypto";
import { MONTH_FOLDER_NAMES } from "../months.js";

export const XLSX_MIME   = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const FOLDER_MIME = "application/vnd.google-apps.folder";
export const IN_CI       = process.env.GITHUB_ACTIONS === "true";

export function googleAuth(): OAuth2Client {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error("Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN");
  }
  const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return auth;
}

export function createDrive(): drive_v3.Drive {
  return google.drive({ version: "v3", auth: googleAuth() });
}

/** Retry rate limits and server errors; anything else fails at once. */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const code = Number((err as { code?: unknown }).code);
      if (attempt >= 4 || !(code === 429 || code >= 500)) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

export async function listChildren(drive: drive_v3.Drive, parentId: string, folders: boolean): Promise<drive_v3.Schema$File[]> {
  const all: drive_v3.Schema$File[] = [];
  let pageToken: string | undefined;
  do {
    const res: drive_v3.Schema$FileList = (await withRetry(() => drive.files.list({
      q: `'${parentId}' in parents and trashed=false and mimeType${folders ? "=" : "!="}'${FOLDER_MIME}'`,
      fields: "nextPageToken,files(id,name,mimeType,md5Checksum,modifiedTime)",
      pageSize: 1000, pageToken,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    }))).data;
    all.push(...(res.files ?? []));
    pageToken = res.nextPageToken ?? undefined;
  } while (pageToken);
  return all;
}

export async function download(drive: drive_v3.Drive, fileId: string): Promise<Buffer> {
  const res = await withRetry(() => drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  ));
  return Buffer.from(res.data as ArrayBuffer);
}

export const md5 = (b: Buffer): string => createHash("md5").update(b).digest("hex");

export function labelOf(month: string, file: drive_v3.Schema$File): string {
  return IN_CI
    ? `${month} #${createHash("sha256").update(file.id!).digest("hex").slice(0, 8)}`
    : `${month} ${file.name}`;
}

export async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }));
  return out;
}

/** The month folders under P4P root, as "2569_07", oldest first. */
export async function monthFolders(
  drive: drive_v3.Drive, rootId: string, year: string | null, month: number | null,
): Promise<{ monthKey: string; folderId: string }[]> {
  if (month !== null && !MONTH_FOLDER_NAMES[month]) throw new Error(`Invalid month: ${month}`);
  const out: { monthKey: string; folderId: string }[] = [];
  const years = (await listChildren(drive, rootId, true))
    .filter((f) => /^\d{4}$/.test(f.name ?? "") && (!year || f.name === year))
    .sort((a, b) => a.name!.localeCompare(b.name!));
  for (const y of years) {
    const months = (await listChildren(drive, y.id!, true))
      .map((f) => ({ f, num: Number(Object.entries(MONTH_FOLDER_NAMES).find(([, name]) => name === f.name)?.[0]) }))
      .filter(({ num }) => Number.isInteger(num) && (month === null || num === month))
      .sort((a, b) => a.num - b.num);
    for (const { f, num } of months) out.push({ monthKey: `${y.name}_${String(num).padStart(2, "0")}`, folderId: f.id! });
  }
  return out;
}
