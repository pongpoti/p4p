/**
 * fix-drive-sharing.mjs
 *
 * Removes public ("anyone with the link") access from the P4P Drive tree and
 * replaces it with named access.
 *
 * THE PROBLEM
 * -----------
 * Every folder and file sampled in the P4P tree carried
 * {"role":"reader","type":"anyone"} — readable by anyone on the internet, no
 * sign-in. Because the FOLDERS are shared too, the tree can be browsed: one
 * link enumerates every physician's file. The files are titled with each
 * physician's full name and hold their raw workload spreadsheet.
 *
 * Nothing in this repository ever set that. It was applied by hand to a parent
 * folder, and every upload since inherited it — which is why it never showed up
 * in a code review.
 *
 * WHAT THIS DOES
 * --------------
 * The tree is  root / <department> / <month> / <physician>.xlsx  so access maps
 * cleanly onto departments:
 *
 *   1. delete every `anyone` (and `domain`) permission it finds, top-down
 *   2. grant each department head `reader` on THEIR department folder — Drive
 *      inherits downward, so that covers every month and every file inside
 *   3. grant the oversight admin `reader` on each root
 *
 * The Drive owner already holds `owner` and is never touched, and the
 * p4p-service-account writer permission is preserved so the automation keeps
 * working.
 *
 * DRY RUN BY DEFAULT. Prints the plan and changes nothing. Pass --apply to
 * execute.
 *
 *   node scripts/fix-drive-sharing.mjs
 *   node scripts/fix-drive-sharing.mjs --apply
 *   node scripts/fix-drive-sharing.mjs --root=<extraFolderId> --apply
 *
 * Requires the same GOOGLE_* credentials the rest of the automation uses. Their
 * OAuth scope is full `drive`, so managing permissions is already permitted.
 *
 * ⚠️  NON-GOOGLE ADDRESSES. A Drive ACL grants access to a GOOGLE ACCOUNT. Most
 *     dept_heads rows are @hotmail/@yahoo addresses, which usually cannot open
 *     the file unless a Google account exists for that address. The script
 *     still creates the grant (harmless, and it works the moment they have one)
 *     but WARNS for each, so you can see who will lose access before --apply.
 */

import { google } from "googleapis";
import { getDeptHeads } from "../supabase-client.js";

const APPLY = process.argv.includes("--apply");
const EXTRA_ROOTS = process.argv
  .filter((a) => a.startsWith("--root="))
  .map((a) => a.slice("--root=".length))
  .filter(Boolean);

/** Addresses that keep access to everything. The Drive owner already has
 *  `owner` on every node, so only the oversight admin needs an explicit grant.
 *  Read from the environment — never hardcode a personal address in this repo. */
const ADMIN_EMAILS = (process.env.DRIVE_ADMIN_EMAILS ?? process.env.OVERSIGHT_EMAIL ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const GOOGLE_DOMAINS = /@(gmail|googlemail)\.com$/i;

function drive() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error("Missing Google credentials (GOOGLE_CLIENT_ID / _SECRET / _REFRESH_TOKEN)");
  }
  const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return google.drive({ version: "v3", auth });
}

const stats = { scanned: 0, publicFound: 0, publicRemoved: 0, granted: 0, failed: 0 };

/** Every child of a folder, paginated. */
async function children(api, folderId) {
  const out = [];
  let pageToken;
  do {
    const res = await api.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: "nextPageToken, files(id, name, mimeType)",
      pageSize: 200,
      pageToken,
    });
    out.push(...(res.data.files ?? []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return out;
}

/**
 * Strip public access from one node.
 *
 * An INHERITED permission cannot be deleted at the child — Drive rejects it.
 * That is expected and not an error: clearing it at the ancestor already
 * covered this node, so the failure is logged at debug level only.
 */
async function stripPublic(api, id, label) {
  stats.scanned++;
  let perms;
  try {
    const res = await api.permissions.list({
      fileId: id,
      fields: "permissions(id, type, role, emailAddress)",
    });
    perms = res.data.permissions ?? [];
  } catch (err) {
    console.warn(`  ⚠️  cannot read permissions on ${label}: ${err.message}`);
    stats.failed++;
    return;
  }

  for (const p of perms) {
    if (p.type !== "anyone" && p.type !== "domain") continue;
    stats.publicFound++;
    console.log(`  🔓 ${label} — ${p.type}/${p.role}`);
    if (!APPLY) continue;
    try {
      await api.permissions.delete({ fileId: id, permissionId: p.id });
      stats.publicRemoved++;
    } catch (err) {
      // Inherited permissions are removed at the ancestor, not here.
      if (!/inherited/i.test(err.message)) {
        console.warn(`     could not remove: ${err.message}`);
        stats.failed++;
      }
    }
  }
}

/** Grant one address `reader` on a node, idempotently. */
async function grantReader(api, id, email, label) {
  if (!GOOGLE_DOMAINS.test(email)) {
    console.warn(`  ⚠️  ${email} is not a Google address — the grant is created but they likely`);
    console.warn(`      cannot open the files until a Google account exists for it (${label})`);
  }
  console.log(`  ➕ ${label} → ${email} (reader)`);
  if (!APPLY) return;
  try {
    await api.permissions.create({
      fileId: id,
      requestBody: { type: "user", role: "reader", emailAddress: email },
      // No email blast to 18 people from a security cleanup.
      sendNotificationEmail: false,
    });
    stats.granted++;
  } catch (err) {
    console.warn(`     grant failed: ${err.message}`);
    stats.failed++;
  }
}

/** Depth-first strip of public access over the whole subtree. */
async function stripTree(api, id, label, depth = 0) {
  await stripPublic(api, id, label);
  const kids = await children(api, id);
  for (const kid of kids) {
    const isFolder = kid.mimeType === "application/vnd.google-apps.folder";
    const childLabel = `${label}/${kid.name}`;
    if (isFolder) await stripTree(api, kid.id, childLabel, depth + 1);
    else await stripPublic(api, kid.id, childLabel);
  }
}

async function main() {
  const roots = [process.env.P4P_FOLDER_ID, ...EXTRA_ROOTS].filter(Boolean);
  if (roots.length === 0) throw new Error("Set P4P_FOLDER_ID (and/or pass --root=<id>)");

  const api = drive();
  const deptHeads = await getDeptHeads();
  const deptCount = Object.keys(deptHeads).length;

  console.log(APPLY ? "▶  APPLYING CHANGES\n" : "▶  DRY RUN — nothing will be changed. Pass --apply to execute.\n");
  console.log(`Roots        : ${roots.join(", ")}`);
  console.log(`Dept heads   : ${deptCount} from the dept_heads table`);
  console.log(`Admin grants : ${ADMIN_EMAILS.length ? ADMIN_EMAILS.join(", ") : "(none — set DRIVE_ADMIN_EMAILS or OVERSIGHT_EMAIL)"}\n`);

  for (const root of roots) {
    const meta = await api.files.get({ fileId: root, fields: "id, name" });
    const rootName = meta.data.name ?? root;
    console.log(`\n═══ ${rootName} (${root}) ═══`);

    console.log("\n── removing public access ──");
    await stripTree(api, root, rootName);

    console.log("\n── granting admins on the root ──");
    for (const email of ADMIN_EMAILS) await grantReader(api, root, email, rootName);

    console.log("\n── granting dept heads on their department folder ──");
    const unmatched = [];
    for (const folder of await children(api, root)) {
      if (folder.mimeType !== "application/vnd.google-apps.folder") continue;
      const head = deptHeads[folder.name];
      if (!head) {
        unmatched.push(folder.name);
        continue;
      }
      await grantReader(api, folder.id, head, folder.name);
    }
    if (unmatched.length) {
      console.warn(`\n  ⚠️  ${unmatched.length} folder(s) have no dept_heads row — NOBODY will be`);
      console.warn(`      granted access to these, so check the names match the table exactly:`);
      for (const n of unmatched) console.warn(`        • ${n}`);
    }
  }

  console.log("\n═══ summary ═══");
  console.log(`  nodes scanned      : ${stats.scanned}`);
  console.log(`  public perms found : ${stats.publicFound}`);
  if (APPLY) console.log(`  public perms removed: ${stats.publicRemoved}`);
  if (APPLY) console.log(`  grants created     : ${stats.granted}`);
  console.log(`  failures           : ${stats.failed}`);
  if (!APPLY) console.log("\nRe-run with --apply to make these changes.");
}

main().catch((err) => {
  console.error("fix-drive-sharing failed:", err.message);
  process.exit(1);
});
