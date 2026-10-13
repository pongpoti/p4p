/**
 * scripts/unstar-p4p-emails.ts
 *
 * One-off cleanup: removes the star from every existing message labelled
 * "เอกสาร P4P". Submission emails are no longer starred by the pipeline, so
 * this brings the older mail in line.
 *
 * Only the STARRED system label is removed — nothing is archived, relabelled
 * or deleted.
 *
 * Environment variables:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 *   DRY_RUN   "false" to actually unstar. Anything else (default) only
 *             reports how many messages would be changed.
 */

import { google, type gmail_v1 } from "googleapis";
import { config as dotenvConfig } from "dotenv";

dotenvConfig({ override: true });

const LABEL_NAME = "เอกสาร P4P";
const BATCH_SIZE = 1000; // Gmail batchModify limit

async function listStarredIds(gmail: gmail_v1.Gmail, labelId: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const res = await gmail.users.messages.list({
      userId: "me",
      labelIds: [labelId, "STARRED"], // both labels must be present
      includeSpamTrash: true,
      maxResults: 500,
      pageToken,
    });
    for (const m of res.data.messages ?? []) if (m.id) ids.push(m.id);
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return ids;
}

async function main(): Promise<void> {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error("Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN");
  }
  const dryRun = process.env["DRY_RUN"] !== "false";

  const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  const gmail = google.gmail({ version: "v1", auth });

  const labels = (await gmail.users.labels.list({ userId: "me" })).data.labels ?? [];
  const label = labels.find((l) => l.name === LABEL_NAME);
  if (!label?.id) throw new Error(`Label "${LABEL_NAME}" not found`);

  const ids = await listStarredIds(gmail, label.id);
  console.log(`⭐ ${ids.length} starred message(s) labelled "${LABEL_NAME}"`);

  if (dryRun) {
    console.log("DRY RUN — nothing changed. Re-run with dry_run=false to unstar them.");
    return;
  }

  let done = 0;
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const chunk = ids.slice(i, i + BATCH_SIZE);
    await gmail.users.messages.batchModify({
      userId: "me",
      requestBody: { ids: chunk, removeLabelIds: ["STARRED"] },
    });
    done += chunk.length;
    console.log(`  unstarred ${done}/${ids.length}`);
  }
  console.log(`✅ Unstarred ${done} message(s)`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
