/**
 * scripts/mail-originals.ts
 *
 * The .xlsx attachments of a Gmail message, as the physician sent them —
 * the originals the archive scripts compare Drive copies with.
 */

import type { gmail_v1 } from "googleapis";
import { withRetry } from "./drive-walk.js";

/** Every part of a message that carries an .xlsx/.xlsm workbook. */
export function xlsxParts(part: gmail_v1.Schema$MessagePart | undefined, out: gmail_v1.Schema$MessagePart[] = []): gmail_v1.Schema$MessagePart[] {
  if (!part) return out;
  const named = part.filename && (/\.xls[xm]$/i.test(part.filename) || /spreadsheetml/.test(part.mimeType ?? ""));
  if (named && (part.body?.attachmentId || part.body?.data)) out.push(part);
  for (const child of part.parts ?? []) xlsxParts(child, out);
  return out;
}

/** The bytes of one such part, fetched if Gmail keeps it as a separate attachment. */
export async function partBytes(gmail: gmail_v1.Gmail, messageId: string, part: gmail_v1.Schema$MessagePart): Promise<Buffer | null> {
  const data = part.body?.attachmentId
    ? (await withRetry(() => gmail.users.messages.attachments.get({ userId: "me", messageId, id: part.body!.attachmentId! }))).data.data
    : part.body?.data;
  return data ? Buffer.from(data, "base64url") : null;
}
