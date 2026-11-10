/**
 * An in-memory Gmail client for readSubmissionEmails() tests: a mailbox of
 * messages (grouped into threads), with read/label state that modifyMessage
 * changes, so a second poll sees exactly what the first one left behind.
 * Not a test file itself.
 */
import { P4P_LABEL_NAME } from "../gmail-client.js";
import type { DecodedMessage, GmailAttachment } from "../types.js";

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export interface FakeMessage {
  msg: DecodedMessage;
  attachments: GmailAttachment[];
  /** attachmentId -> bytes */
  files?: Record<string, Buffer>;
  labels: Set<string>;
}

export function fakeGmail(messages: FakeMessage[]) {
  const sent: { to: string; subject: string; html?: string; body?: string; replyToMessageId?: string }[] = [];
  const modified: { id: string; add: string[]; remove: string[] }[] = [];
  const byId = new Map(messages.map((m) => [m.msg.id, m]));

  const client = {
    sent, modified,
    async listLabels() { return [{ id: "LBL_P4P", name: P4P_LABEL_NAME }]; },
    async listMessages({ labelIds }: { labelIds?: string | string[] }) {
      const folder = Array.isArray(labelIds) ? labelIds[0] : labelIds;
      return messages
        .filter((m) => m.labels.has(folder ?? "INBOX") && m.labels.has("UNREAD") && !m.labels.has("LBL_P4P"))
        .map((m) => ({ id: m.msg.id }));
    },
    async getMessageWithAttachments(id: string) {
      const m = byId.get(id);
      if (!m) throw new Error(`no message ${id}`);
      return { msg: m.msg, attachments: m.attachments };
    },
    async getThreadMessages(threadId: string) {
      return messages.filter((m) => m.msg.threadId === threadId).map((m) => ({ msg: m.msg, attachments: m.attachments }));
    },
    async downloadAttachment(messageId: string, attachmentId: string) {
      const b = byId.get(messageId)?.files?.[attachmentId];
      if (!b) throw new Error(`no attachment ${attachmentId}`);
      return b;
    },
    async sendMessage(o: { to: string; subject: string; html?: string; body?: string; replyToMessageId?: string }) {
      sent.push(o);
      return { id: `sent${sent.length}` };
    },
    async modifyMessage(id: string, add: string[] = [], remove: string[] = []) {
      modified.push({ id, add, remove });
      const m = byId.get(id);
      if (m) { for (const l of add) m.labels.add(l); for (const l of remove) m.labels.delete(l); }
      return {};
    },
  };
  return client;
}
