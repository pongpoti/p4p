#!/usr/bin/env node
/**
 * Populate year + month subfolders inside the Google Drive root folder.
 * Mirrors the GAS populateFolders() function.
 * Run once on 1 January each year via GitHub Actions.
 */

import type { drive_v3 } from 'googleapis';

require('dotenv').config();

const { google } = require('googleapis') as typeof import('googleapis');

interface Config {
  google: {
    clientId: string | undefined;
    clientSecret: string | undefined;
    refreshToken: string | undefined;
  };
  rootFolderId: string | undefined;
}

const CONFIG: Config = {
  google: {
    clientId:     process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
  },
  rootFolderId: process.env.GOOGLE_ROOT_FOLDER_ID,
};

const THAI_MONTHS = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน',
  'พฤษภาคม', 'มิถุนายน',  'กรกฎาคม', 'สิงหาคม',
  'กันยายน', 'ตุลาคม',    'พฤศจิกายน', 'ธันวาคม',
];

function log(msg: string): void { console.log(msg); }

async function main(): Promise<void> {
  if (!CONFIG.rootFolderId) throw new Error('GOOGLE_ROOT_FOLDER_ID is not set');

  const auth = new google.auth.OAuth2(CONFIG.google.clientId, CONFIG.google.clientSecret);
  auth.setCredentials({ refresh_token: CONFIG.google.refreshToken });
  const drive: drive_v3.Drive = google.drive({ version: 'v3', auth });

  const beYear = (new Date().getFullYear() + 543).toString();
  log(`[populate] Target year (BE): ${beYear}`);

  // Check if year folder already exists
  const existing = await drive.files.list({
    q: `'${CONFIG.rootFolderId}' in parents and name = '${beYear}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 1,
  });

  // files(...) was explicitly requested in `fields` above, so Drive always
  // returns an array (possibly empty) here — the `!` just tells TS what the
  // API guarantees; it doesn't change what runs.
  if (existing.data.files!.length > 0) {
    log(`[populate] Folder '${beYear}' already exists (${existing.data.files![0].id}). Nothing to do.`);
    return;
  }

  // Create year folder
  const yearRes = await drive.files.create({
    requestBody: {
      name: beYear,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [CONFIG.rootFolderId],
    },
    fields: 'id',
  });
  const yearFolderId = yearRes.data.id;
  log(`[populate] Created year folder '${beYear}' → ${yearFolderId}`);

  // Create 12 month subfolders
  for (let i = 0; i < 12; i++) {
    const monthName = `${i + 1} - ${THAI_MONTHS[i]}`;
    const res = await drive.files.create({
      requestBody: {
        name: monthName,
        mimeType: 'application/vnd.google-apps.folder',
        // `fields: 'id'` above means Drive always returns an id here.
        parents: [yearFolderId!],
      },
      fields: 'id',
    });
    log(`[populate]   Created '${monthName}' → ${res.data.id}`);
  }

  log('[populate] Done.');
}

main().catch((err: any) => {
  console.error('[populate] ERROR:', err.message || err);
  process.exit(1);
});
