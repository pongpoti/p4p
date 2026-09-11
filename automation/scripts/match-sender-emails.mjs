/**
 * scripts/match-sender-emails.mjs
 *
 * For every message in Gmail label "เอกสาร P4P":
 *   1. Extract physician name from xlsx attachment filename, email subject, or body
 *      (JS-side only — same logic as the live pipeline in index.js)
 *   2. If still no name, download the xlsx and scan sheet header cells / tab name
 *   3. Fuzzy-match the name against all YYYY_MM Supabase roster tables
 *
 * Groups messages by sender email — stops trying once a confident match is found.
 * Upserts results into the sender_physician_match Supabase table (one row per
 * sender_email; see sql/sender_physician_match.sql for the table definition).
 *
 * Environment variables:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 *   SUPABASE_URL, SUPABASE_KEY
 */

import "../redact.js";   // MUST be first: patches console before anything logs (public job logs)

import { google }        from "googleapis";
import { createClient }  from "@supabase/supabase-js";
import { config as dotenvConfig } from "dotenv";

import { createGmailClient }                                       from "../gmail-client.js";
import { resolvePhysicianName, resolvePhysicianNameFromSheet }     from "../claude-analyst.js";
import { matchName, saveSenderMatch }                               from "../supabase-client.js";
import { MONTH_TOKENS_BY_NUM }                                     from "../months.js";
import { parseExcel }                                              from "../excel-parse.js";

dotenvConfig({ override: true });

const LABEL_NAME = "เอกสาร P4P";

// ── Parse "Display Name <email@host>" or bare "email@host" ───────────────────
function parseFrom(header) {
  const m = header.match(/^(.*?)\s*<([^>]+)>\s*$/);
  return m
    ? { name: m[1].trim(), email: m[2].trim().toLowerCase() }
    : { name: "", email: header.trim().toLowerCase() };
}

// ── Paginate all message IDs in a label ──────────────────────────────────────
async function listAllIds(gmail, labelId) {
  const ids = [];
  let pageToken;
  do {
    const res = await gmail.users.messages.list({
      userId: "me", labelIds: [labelId], maxResults: 500, pageToken,
    });
    for (const m of res.data.messages ?? []) ids.push(m.id);
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return ids;
}

// parseExcel now lives in ../excel-parse.js (shared with
// backfill-drive-scores.mjs — was independently duplicated in both scripts).

// ── Discover all YYYY_MM roster tables via PostgREST OpenAPI spec ─────────────
async function getRosterTables() {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/`, {
    headers: {
      apikey: process.env.SUPABASE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`PostgREST spec fetch failed: ${res.status}`);
  const spec = await res.json();
  return Object.keys(spec.paths ?? {})
    .map(p => p.replace(/^\//, ""))
    .filter(t => /^\d{4}_\d{2}$/.test(t))
    .sort();
}

// ── Try to find + match a physician name from one message ─────────────────────
async function tryMessage(gmailClient, rawGmail, msgId, tables) {
  const { msg, attachments } = await gmailClient.getMessageWithAttachments(msgId);
  const xlsx = attachments.find(a => /\.xlsx$/i.test(a.filename ?? ""));

  // Pass 1: JS-side extraction from filename / subject / body
  const nameFromMeta = resolvePhysicianName(xlsx?.filename ?? null, msg.subject, msg.body);

  if (nameFromMeta) {
    for (const table of tables) {
      const hit = await matchName(nameFromMeta, table);
      if (hit) return { extractedName: nameFromMeta, source: "filename/subject/body", hit };
    }
  }

  // Pass 2: download xlsx and scan sheet header cells / tab name
  if (xlsx) {
    try {
      const res = await rawGmail.users.messages.attachments.get({
        userId: "me", messageId: msgId, id: xlsx.attachmentId,
      });
      const base64 = res.data.data.replace(/-/g, "+").replace(/_/g, "/");
      const buffer = Buffer.from(base64, "base64");
      const { rows, sheetName } = await parseExcel(buffer, null, MONTH_TOKENS_BY_NUM);
      const candidates = resolvePhysicianNameFromSheet(rows, sheetName);

      for (const candidate of candidates) {
        for (const table of tables) {
          const hit = await matchName(candidate, table);
          if (hit) return { extractedName: candidate, source: "excel_sheet", hit };
        }
      }
    } catch {
      // attachment download / parse failed — skip
    }
  }

  return null; // could not resolve
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${"═".repeat(60)}`);
  console.log("  Gmail → Supabase  Sender / Physician Match");
  console.log(`${"═".repeat(60)}\n`);

  const gmailClient = createGmailClient();

  // Raw googleapis client (needed for attachment download pagination)
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN)
    throw new Error("Missing Google OAuth env vars");
  const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  const rawGmail = google.gmail({ version: "v1", auth });

  // ── Step 1: resolve label ────────────────────────────────────────────────
  const labels = await gmailClient.listLabels(LABEL_NAME);
  if (!labels.length) throw new Error(`Label "${LABEL_NAME}" not found`);
  const labelId = labels[0].id;
  console.log(`📂  Label: "${LABEL_NAME}" (${labelId})`);

  // ── Step 2: list all message IDs ─────────────────────────────────────────
  console.log("📧  Listing messages…");
  const allIds = await listAllIds(rawGmail, labelId);
  console.log(`    ${allIds.length} messages found\n`);

  // ── Step 3: group by sender (lightweight metadata fetch) ─────────────────
  console.log("👤  Grouping by sender…");
  const senderMap = new Map(); // email → { displayName, email, messageIds[] }

  for (let i = 0; i < allIds.length; i++) {
    const res = await rawGmail.users.messages.get({
      userId: "me", id: allIds[i], format: "metadata", metadataHeaders: ["From"],
    });
    const fromVal = res.data.payload?.headers
      ?.find(h => h.name.toLowerCase() === "from")?.value ?? "";
    if (!fromVal) continue;

    const { name, email } = parseFrom(fromVal);
    if (!senderMap.has(email)) {
      senderMap.set(email, { displayName: name, email, messageIds: [allIds[i]] });
    } else {
      senderMap.get(email).messageIds.push(allIds[i]);
    }

    if ((i + 1) % 50 === 0) console.log(`  … ${i + 1}/${allIds.length} scanned`);
  }
  console.log(`\n    ${senderMap.size} unique senders\n`);

  // ── Step 4: discover roster tables ───────────────────────────────────────
  console.log("📋  Loading Supabase roster tables…");
  const tables = await getRosterTables();
  console.log(`    Tables: ${tables.join(", ")}\n`);

  // ── Step 5: match each sender ─────────────────────────────────────────────
  console.log("🔍  Matching senders…\n");
  const results = [];

  let done = 0;
  for (const { displayName, email, messageIds } of senderMap.values()) {
    done++;
    process.stdout.write(`[${done}/${senderMap.size}] ${email} … `);

    let result = null;

    // Try messages (most recent first) until a match is found
    for (const msgId of messageIds) {
      try {
        result = await tryMessage(gmailClient, rawGmail, msgId, tables);
        if (result) break;
      } catch {
        // skip failed messages
      }
    }

    const senderMatch = result
      ? {
          senderEmail: email, senderDisplayName: displayName, emailCount: messageIds.length,
          extractedName: result.extractedName, nameSource: result.source,
          matchedPhysician: result.hit.matchedName, department: result.hit.department,
          similarity: result.hit.similarity.toFixed(3), matched: "yes",
        }
      : {
          senderEmail: email, senderDisplayName: displayName, emailCount: messageIds.length,
          extractedName: "", nameSource: "none",
          matchedPhysician: "", department: "", similarity: "0.000", matched: "no",
        };

    if (result) console.log(`✅ ${result.hit.matchedName} (${(result.hit.similarity * 100).toFixed(0)}%)`);
    else        console.log("—");

    await saveSenderMatch(senderMatch);
    results.push(senderMatch);
  }

  const matchedCount = results.filter(r => r.matched === "yes").length;
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ✅  ${matchedCount} matched  /  ${results.length} total senders`);
  console.log(`  📄  Upserted into sender_physician_match`);
  console.log(`${"═".repeat(60)}\n`);
}

main().catch(err => {
  console.error("\n❌ Fatal:", err.message);
  process.exit(1);
});
