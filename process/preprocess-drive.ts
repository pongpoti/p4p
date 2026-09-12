#!/usr/bin/env node
/**
 * Preprocess: cleans each target month's Drive folder before process.ts runs.
 *
 *   1. Duplicate uploads (two+ files sharing the same physician name in the
 *      same month folder) — keep the newest, trash the rest.
 *      This is what silently broke 2569_04: two files named
 *      "นิธินันท์ สร้อยอากาศ" made Drive report 192 files against 191
 *      Supabase rows, so process.ts's listsMatch() rejected the whole month.
 *   2. Unrelated files — a Drive file whose name doesn't match any row
 *      (exact or substring) in that month's Supabase table.
 *
 * Both cases only trash files (recoverable from Drive trash for ~30 days) —
 * nothing is permanently deleted by this script, since a name mismatch or
 * duplicate can also indicate a typo that needs a human to reconcile rather
 * than lose the file outright.
 *
 * Usage: node preprocess-drive.js
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { drive_v3 } from 'googleapis';
import type { DriveFile, MonthInfo } from './types';

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js') as typeof import('@supabase/supabase-js');
const {
  log, stripExt, normaliseName,
  createDriveClient, driveListAll, listFolders,
} = require('./lib') as typeof import('./lib');

interface Config {
  supabase: {
    url: string | undefined;
    key: string | undefined;
  };
  rootFolderId: string | undefined;
}

const CONFIG: Config = {
  supabase: {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_KEY,
  },
  rootFolderId: process.env.GOOGLE_ROOT_FOLDER_ID,
};

const THAI_MONTHS: Record<number, string> = {
  1:'มกราคม', 2:'กุมภาพันธ์', 3:'มีนาคม', 4:'เมษายน',
  5:'พฤษภาคม', 6:'มิถุนายน', 7:'กรกฎาคม', 8:'สิงหาคม',
  9:'กันยายน', 10:'ตุลาคม', 11:'พฤศจิกายน', 12:'ธันวาคม',
};

/** Case-insensitive variant of lib's normaliseName, for name matching below. */
function normLower(name?: string | null): string { return normaliseName(name).toLowerCase(); }

function getTargetMonths(): MonthInfo[] {
  const now = new Date();
  return Array.from({ length: 6 }, (_, i) => {
    const d      = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const beYear = d.getFullYear() + 543;
    const month  = d.getMonth() + 1;
    return { key: `${beYear}_${String(month).padStart(2, '0')}`, beYear, month };
  });
}

/** Like lib's listExcelFiles, but also fetches modifiedTime for dedupe sorting. */
async function listExcelFilesWithMeta(drive: drive_v3.Drive, folderId: string): Promise<DriveFile[]> {
  const mimes = [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
  ].map(m => `mimeType='${m}'`).join(' or ');
  return driveListAll(drive, {
    q: `'${folderId}' in parents and (${mimes}) and trashed=false`,
    fields: 'nextPageToken, files(id, name, modifiedTime)', pageSize: 100,
  });
}

async function findMonthFolder(drive: drive_v3.Drive, { beYear, month }: MonthInfo): Promise<DriveFile | null> {
  const yearFolders = await listFolders(drive, CONFIG.rootFolderId!);
  const yearFolder  = yearFolders.find(f => f.name === String(beYear));
  if (!yearFolder) return null;

  const thai       = THAI_MONTHS[month];
  const candidates = [`${month} - ${thai}`, `${String(month).padStart(2, '0')} - ${thai}`];
  const monthFolders = await listFolders(drive, yearFolder.id!);
  return monthFolders.find(f => candidates.includes(f.name!)) ?? null;
}

async function getSupabaseNames(supabase: SupabaseClient, tableKey: string): Promise<string[] | null> {
  const { data, error } = await supabase.from(tableKey).select('firstname, lastname');
  if (error) return null; // table missing/empty — can't judge "unrelated", skip that check
  return (data ?? []).map((r: any) => normLower(`${r.firstname ?? ''} ${r.lastname ?? ''}`));
}

/** Exact match, then substring containment either way — mirrors automation/scripts/check-month.mjs. */
function matchesAny(normName: string, sbNames: string[]): boolean {
  if (sbNames.includes(normName)) return true;
  return sbNames.some(n => n.includes(normName) || normName.includes(n));
}

async function removeDuplicates(
  drive: drive_v3.Drive,
  files: DriveFile[]
): Promise<{ kept: DriveFile[]; removed: number }> {
  const byName = new Map<string, DriveFile[]>();
  for (const f of files) {
    const key = normLower(stripExt(f.name!));
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key)!.push(f);
  }

  const kept: DriveFile[] = [];
  let removed = 0;
  for (const [name, group] of byName) {
    if (group.length === 1) { kept.push(group[0]); continue; }
    group.sort((a, b) => new Date(b.modifiedTime!).getTime() - new Date(a.modifiedTime!).getTime());
    const [newest, ...older] = group;
    kept.push(newest);
    log(`  [Dedupe] "${name}" — ${group.length} copies, keeping ${newest.id} (${newest.modifiedTime})`, 'warn');
    for (const dupe of older) {
      await drive.files.update({ fileId: dupe.id!, requestBody: { trashed: true } });
      log(`    ✗ trashed duplicate ${dupe.id} (${dupe.modifiedTime})`, 'warn');
      removed++;
    }
  }
  return { kept, removed };
}

async function trashUnrelated(
  drive: drive_v3.Drive,
  files: DriveFile[],
  sbNames: string[] | null
): Promise<{ kept: DriveFile[]; trashed: number }> {
  if (sbNames === null) return { kept: files, trashed: 0 }; // no Supabase data to compare against

  const kept: DriveFile[] = [];
  let trashed = 0;
  for (const f of files) {
    const normName = normLower(stripExt(f.name!));
    if (matchesAny(normName, sbNames)) {
      kept.push(f);
    } else {
      await drive.files.update({ fileId: f.id!, requestBody: { trashed: true } });
      log(`  [Unrelated] ✗ trashed "${f.name}" (no matching Supabase row)`, 'warn');
      trashed++;
    }
  }
  return { kept, trashed };
}

async function main(): Promise<void> {
  const missing = (
    [
      ['GOOGLE_CLIENT_ID',      process.env.GOOGLE_CLIENT_ID],
      ['GOOGLE_CLIENT_SECRET',  process.env.GOOGLE_CLIENT_SECRET],
      ['GOOGLE_REFRESH_TOKEN',  process.env.GOOGLE_REFRESH_TOKEN],
      ['SUPABASE_URL',          CONFIG.supabase.url],
      ['SUPABASE_KEY',          CONFIG.supabase.key],
      ['GOOGLE_ROOT_FOLDER_ID', CONFIG.rootFolderId],
    ] as [string, string | undefined][]
  ).filter(([, v]) => !v).map(([k]) => k);

  if (missing.length > 0) {
    console.error('\n❌  Missing variables in .env:');
    missing.forEach(k => console.error(`     • ${k}`));
    process.exit(1);
  }

  const drive    = createDriveClient();
  const supabase = createClient(CONFIG.supabase.url!, CONFIG.supabase.key!);
  const months   = getTargetMonths();

  console.log('══════════════════════════════════════════════════════');
  console.log(' Drive Preprocess — dedupe + unrelated-file cleanup');
  console.log('══════════════════════════════════════════════════════');

  let totalRemoved = 0, totalTrashed = 0;

  for (const monthInfo of months) {
    const { key } = monthInfo;
    console.log(`\n┌─ ${key} ${'─'.repeat(46 - key.length)}`);

    const folder = await findMonthFolder(drive, monthInfo);
    if (!folder) { console.log('└─ no Drive folder — skipped'); continue; }

    const files = await listExcelFilesWithMeta(drive, folder.id!);
    if (files.length === 0) { console.log('└─ no files — skipped'); continue; }
    log(`  Found ${files.length} file(s)`);

    const { kept: afterDedupe, removed } = await removeDuplicates(drive, files);
    totalRemoved += removed;

    const sbNames = await getSupabaseNames(supabase, key);
    const { trashed } = await trashUnrelated(drive, afterDedupe, sbNames);
    totalTrashed += trashed;

    log(`  → ${removed} duplicate(s) trashed, ${trashed} unrelated file(s) trashed`);
    console.log('└─ done');
  }

  console.log('\n══════════════════════════════════════════════════════');
  console.log(` ✓ Duplicates trashed : ${totalRemoved}`);
  console.log(` ✓ Unrelated trashed  : ${totalTrashed}`);
  console.log('');
}

main().catch((err: any) => {
  console.error(`\n❌  Fatal: ${err.stack ?? err.message}`);
  process.exit(1);
});
