// @nodal-agents/adapter-gmail — message tools
// send, list, get, reply, modify-labels, forward, trash, untrash, delete

import { z } from 'zod';
import type { ToolDefinition } from '@nodal-agents/tools';
import type { gmail_v1 } from 'googleapis';
import { mapGmailError, GmailAdapterError } from '../errors';
import { paginateGmail } from '../helpers/pagination';
import {
  extractTextFromPayload,
  extractAttachmentInfos,
  parseGmailHeaders,
} from '../helpers/parse-payload';
import { buildRfc2822Message } from '../helpers/rfc2822';
import type { AttachmentSpec } from '../helpers/rfc2822';

// Max body chars to return (avoid context overload)
const BODY_CHAR_CAP = 10000;

// ── Attachment schema (reused across send/reply/draft) ─────────────────────

const AttachmentItemSchema = z.object({
  filename: z.string().describe("File name shown in the email, e.g. 'report.html'."),
  content: z
    .string()
    .describe('File content as a string (plain text by default, or base64 if encoding is base64).'),
  mimeType: z
    .string()
    .optional()
    .describe("MIME type, e.g. 'text/html'. Inferred from filename if omitted."),
  encoding: z
    .enum(['text', 'base64'])
    .optional()
    .describe("How content is encoded. Default 'text'. Use 'base64' for pre-encoded binaries."),
});

// ── gmail_send_email ──────────────────────────────────────────────────────────

const SendEmailInput = z.object({
  to: z.string().describe('Recipient email address or comma-separated list.'),
  subject: z.string().describe('Email subject line.'),
  body: z.string().describe('Email body — plain text or HTML.'),
  cc: z.string().optional().describe('CC address(es), comma-separated.'),
  bcc: z.string().optional().describe('BCC address(es), comma-separated.'),
  reply_to: z.string().optional().describe('Reply-To header.'),
  attachments: z
    .array(AttachmentItemSchema)
    .optional()
    .describe(
      'Optional file attachments. Each item: {filename, content, mimeType?, encoding?}. ' +
        "Default encoding is 'text' — pass the file content as a plain string. " +
        "Use encoding='base64' only when you hold pre-encoded binary content.",
    ),
});

export type SendEmailOutput = {
  messageId: string;
  threadId: string;
};

export function createSendEmailTool(
  gmail: gmail_v1.Gmail,
): ToolDefinition<typeof SendEmailInput, SendEmailOutput> {
  return {
    name: 'gmail_send_email',
    description:
      'Send an email via Gmail. Supports plain text and HTML bodies, CC, BCC, Reply-To, and file attachments. ' +
      'Use attachments to send reports, CSVs, or HTML files as real files rather than pasting content inline.',
    inputSchema: SendEmailInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        const raw = buildRfc2822Message({
          to: input.to,
          subject: input.subject,
          body: input.body,
          cc: input.cc,
          bcc: input.bcc,
          replyTo: input.reply_to,
          attachments: input.attachments as AttachmentSpec[] | undefined,
        });
        const res = await gmail.users.messages.send({
          userId: 'me',
          requestBody: { raw },
        });
        return {
          messageId: res.data.id ?? '',
          threadId: res.data.threadId ?? '',
        };
      } catch (err) {
        throw mapGmailError(err);
      }
    },
  };
}

// ── gmail_list_messages ───────────────────────────────────────────────────────

const ListMessagesInput = z.object({
  query: z
    .string()
    .optional()
    .describe(
      "Gmail search query. Examples: 'is:unread', 'from:alice@example.com', 'subject:invoice newer_than:7d'. " +
        'Default: lists recent messages in inbox.',
    ),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe('Max messages to return (1–500, default 20).'),
  include_spam_trash: z
    .boolean()
    .optional()
    .describe('Include messages from SPAM and TRASH (default false).'),
});

export type ListMessagesOutput = {
  total: number;
  messages: Array<{
    messageId: string;
    threadId: string;
    from: string;
    subject: string;
    date: string;
    snippet: string;
    labelIds: string[];
  }>;
};

export function createListMessagesTool(
  gmail: gmail_v1.Gmail,
): ToolDefinition<typeof ListMessagesInput, ListMessagesOutput> {
  return {
    name: 'gmail_list_messages',
    description:
      'List Gmail messages matching a query. Returns message IDs, thread IDs, sender, subject, date and snippet. ' +
      'Use gmail_get_message to read the full body, or gmail_get_thread for the full conversation.',
    inputSchema: ListMessagesInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const maxResults = Math.min(input.max_results ?? 20, 500);

        const messages = await paginateGmail<gmail_v1.Schema$Message>(
          async (pageToken, pageSize) => {
            const params: gmail_v1.Params$Resource$Users$Messages$List = {
              userId: 'me',
              maxResults: pageSize,
              includeSpamTrash: input.include_spam_trash ?? false,
              ...(pageToken && { pageToken }),
              ...(input.query && { q: input.query }),
            };
            const res = await gmail.users.messages.list(params);
            // list returns stub messages with only id+threadId — batch fetch metadata
            const stubs = res.data.messages ?? [];
            return {
              items: stubs,
              nextPageToken: res.data.nextPageToken,
            };
          },
          Math.min(maxResults, 100),
          maxResults,
        );

        // Fetch metadata for each message (Subject, From, Date)
        const detailed = await Promise.all(
          messages.map(async (stub) => {
            try {
              const res = await gmail.users.messages.get({
                userId: 'me',
                id: stub.id!,
                format: 'metadata',
                metadataHeaders: ['Subject', 'From', 'Date'],
              });
              const headers = parseGmailHeaders(res.data.payload ?? undefined);
              return {
                messageId: res.data.id ?? stub.id ?? '',
                threadId: res.data.threadId ?? stub.threadId ?? '',
                from: headers['from'] ?? '',
                subject: headers['subject'] ?? '',
                date: headers['date'] ?? '',
                snippet: res.data.snippet ?? '',
                labelIds: res.data.labelIds ?? [],
              };
            } catch {
              return {
                messageId: stub.id ?? '',
                threadId: stub.threadId ?? '',
                from: '',
                subject: '',
                date: '',
                snippet: '',
                labelIds: [],
              };
            }
          }),
        );

        return { total: detailed.length, messages: detailed };
      } catch (err) {
        throw mapGmailError(err);
      }
    },
  };
}

// ── gmail_get_message ─────────────────────────────────────────────────────────

const GetMessageInput = z.object({
  message_id: z.string().describe('Gmail message ID (from gmail_list_messages).'),
});

export type GetMessageOutput = {
  messageId: string;
  threadId: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  body: string;
  truncated: boolean;
  labelIds: string[];
  attachments: Array<{
    attachmentId: string;
    filename: string;
    mimeType: string;
    size: number;
  }>;
};

export function createGetMessageTool(
  gmail: gmail_v1.Gmail,
): ToolDefinition<typeof GetMessageInput, GetMessageOutput> {
  return {
    name: 'gmail_get_message',
    description:
      'Get the full content of a Gmail message including decoded body and attachment metadata. ' +
      'Use gmail_get_attachment to download an attachment by its ID.',
    inputSchema: GetMessageInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const res = await gmail.users.messages.get({
          userId: 'me',
          id: input.message_id,
          format: 'full',
        });
        const msg = res.data;
        const payload = msg.payload ?? undefined;
        const headers = parseGmailHeaders(payload);

        let body = extractTextFromPayload(payload).trim();
        const truncated = body.length > BODY_CHAR_CAP;
        if (truncated) body = body.slice(0, BODY_CHAR_CAP) + '\n\n[...body truncated]';

        const attachments = extractAttachmentInfos(payload);

        return {
          messageId: msg.id ?? '',
          threadId: msg.threadId ?? '',
          from: headers['from'] ?? '',
          to: headers['to'] ?? '',
          cc: headers['cc'] ?? '',
          subject: headers['subject'] ?? '',
          date: headers['date'] ?? '',
          body,
          truncated,
          labelIds: msg.labelIds ?? [],
          attachments,
        };
      } catch (err) {
        throw mapGmailError(err);
      }
    },
  };
}

// ── gmail_reply_message ───────────────────────────────────────────────────────

const ReplyMessageInput = z.object({
  message_id: z.string().describe('ID of the message to reply to.'),
  body: z.string().describe('Reply body — plain text or HTML.'),
  cc: z.string().optional().describe('CC address(es), comma-separated.'),
  attachments: z
    .array(AttachmentItemSchema)
    .optional()
    .describe('Optional attachments to include with the reply.'),
});

export type ReplyMessageOutput = {
  messageId: string;
  threadId: string;
};

export function createReplyMessageTool(
  gmail: gmail_v1.Gmail,
): ToolDefinition<typeof ReplyMessageInput, ReplyMessageOutput> {
  return {
    name: 'gmail_reply_message',
    description:
      'Reply to a Gmail message in-thread. Automatically sets In-Reply-To, References, subject (Re: prefix), and threadId. ' +
      'Fetches the original message headers to build correct threading.',
    inputSchema: ReplyMessageInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        // Fetch original message metadata for threading headers
        const metaRes = await gmail.users.messages.get({
          userId: 'me',
          id: input.message_id,
          format: 'metadata',
          metadataHeaders: ['Subject', 'From', 'To', 'Message-ID', 'Message-Id', 'References'],
        });
        const meta = metaRes.data;
        const headers = parseGmailHeaders(meta.payload ?? undefined);
        const threadId = meta.threadId ?? undefined;

        const origSubject = headers['subject'] ?? '';
        const replySubject = origSubject.toLowerCase().startsWith('re:')
          ? origSubject
          : `Re: ${origSubject}`;
        const replyTo = headers['from'] ?? '';
        const originalMsgId = headers['message-id'] ?? headers['message-id'] ?? '';
        const priorRefs = headers['references'] ?? '';
        const references = originalMsgId
          ? priorRefs
            ? `${priorRefs} ${originalMsgId}`
            : originalMsgId
          : priorRefs;

        const raw = buildRfc2822Message({
          to: replyTo,
          subject: replySubject,
          body: input.body,
          cc: input.cc,
          inReplyTo: originalMsgId || undefined,
          references: references || undefined,
          attachments: input.attachments as AttachmentSpec[] | undefined,
        });

        const sendBody: gmail_v1.Schema$Message = { raw };
        if (threadId) sendBody.threadId = threadId;

        const res = await gmail.users.messages.send({
          userId: 'me',
          requestBody: sendBody,
        });
        return {
          messageId: res.data.id ?? '',
          threadId: res.data.threadId ?? '',
        };
      } catch (err) {
        throw mapGmailError(err);
      }
    },
  };
}

// ── gmail_forward_message ─────────────────────────────────────────────────────

const ForwardMessageInput = z.object({
  message_id: z.string().describe('ID of the message to forward.'),
  to: z.string().describe('Recipient(s), comma-separated.'),
  note: z.string().optional().describe('Optional note prepended before the forwarded body.'),
  cc: z.string().optional().describe('CC address(es), comma-separated.'),
});

export type ForwardMessageOutput = {
  messageId: string;
  threadId: string;
};

export function createForwardMessageTool(
  gmail: gmail_v1.Gmail,
): ToolDefinition<typeof ForwardMessageInput, ForwardMessageOutput> {
  return {
    name: 'gmail_forward_message',
    description:
      'Forward a Gmail message to new recipients. Quotes the original body and prepends Fwd: to the subject.',
    inputSchema: ForwardMessageInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        const original = await gmail.users.messages.get({
          userId: 'me',
          id: input.message_id,
          format: 'full',
        });
        const payload = original.data.payload ?? undefined;
        const headers = parseGmailHeaders(payload);
        const origSubject = headers['subject'] ?? '';
        const fwdSubject = origSubject.toLowerCase().startsWith('fwd:')
          ? origSubject
          : `Fwd: ${origSubject}`;

        const origBody = extractTextFromPayload(payload).trim();
        const note = input.note ? `${input.note}\n\n` : '';
        const quoted =
          `${note}---------- Forwarded message ----------\n` +
          `From: ${headers['from'] ?? ''}\n` +
          `Date: ${headers['date'] ?? ''}\n` +
          `Subject: ${origSubject}\n` +
          `To: ${headers['to'] ?? ''}\n\n` +
          origBody;

        const raw = buildRfc2822Message({
          to: input.to,
          subject: fwdSubject,
          body: quoted,
          cc: input.cc,
        });

        const res = await gmail.users.messages.send({
          userId: 'me',
          requestBody: { raw },
        });
        return {
          messageId: res.data.id ?? '',
          threadId: res.data.threadId ?? '',
        };
      } catch (err) {
        throw mapGmailError(err);
      }
    },
  };
}

// ── gmail_modify_labels ───────────────────────────────────────────────────────

const ModifyLabelsInput = z.object({
  message_id: z.string().describe('Gmail message ID.'),
  add_labels: z
    .array(z.string())
    .optional()
    .describe("Label IDs or system labels to add, e.g. ['STARRED', 'IMPORTANT']."),
  remove_labels: z
    .array(z.string())
    .optional()
    .describe("Label IDs or system labels to remove, e.g. ['UNREAD', 'INBOX']."),
});

export type ModifyLabelsOutput = {
  messageId: string;
  labelIds: string[];
};

export function createModifyLabelsTool(
  gmail: gmail_v1.Gmail,
): ToolDefinition<typeof ModifyLabelsInput, ModifyLabelsOutput> {
  return {
    name: 'gmail_modify_labels',
    description:
      'Add or remove labels on a Gmail message. System labels: INBOX, UNREAD, STARRED, IMPORTANT, TRASH, SPAM. ' +
      'Use to mark as read (remove UNREAD), star, archive (remove INBOX), etc.',
    inputSchema: ModifyLabelsInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        if (!input.add_labels?.length && !input.remove_labels?.length) {
          throw new GmailAdapterError(
            'gmail_validation_error',
            'Provide at least one of add_labels or remove_labels.',
          );
        }
        const res = await gmail.users.messages.modify({
          userId: 'me',
          id: input.message_id,
          requestBody: {
            addLabelIds: input.add_labels ?? [],
            removeLabelIds: input.remove_labels ?? [],
          },
        });
        return {
          messageId: res.data.id ?? '',
          labelIds: res.data.labelIds ?? [],
        };
      } catch (err) {
        throw mapGmailError(err);
      }
    },
  };
}

// ── gmail_trash_message ───────────────────────────────────────────────────────

const TrashMessageInput = z.object({
  message_id: z.string().describe('Gmail message ID to move to Trash.'),
});

export type TrashMessageOutput = {
  messageId: string;
  threadId: string;
};

export function createTrashMessageTool(
  gmail: gmail_v1.Gmail,
): ToolDefinition<typeof TrashMessageInput, TrashMessageOutput> {
  return {
    name: 'gmail_trash_message',
    description:
      'Move a Gmail message to the Trash folder. Recoverable for 30 days. Prefer this over permanent delete.',
    inputSchema: TrashMessageInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        const res = await gmail.users.messages.trash({
          userId: 'me',
          id: input.message_id,
        });
        return {
          messageId: res.data.id ?? '',
          threadId: res.data.threadId ?? '',
        };
      } catch (err) {
        throw mapGmailError(err);
      }
    },
  };
}

// ── gmail_untrash_message ─────────────────────────────────────────────────────

const UntrashMessageInput = z.object({
  message_id: z.string().describe('Gmail message ID to restore from Trash.'),
});

export type UntrashMessageOutput = {
  messageId: string;
  threadId: string;
};

export function createUntrashMessageTool(
  gmail: gmail_v1.Gmail,
): ToolDefinition<typeof UntrashMessageInput, UntrashMessageOutput> {
  return {
    name: 'gmail_untrash_message',
    description: 'Restore a Gmail message from the Trash folder.',
    inputSchema: UntrashMessageInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        const res = await gmail.users.messages.untrash({
          userId: 'me',
          id: input.message_id,
        });
        return {
          messageId: res.data.id ?? '',
          threadId: res.data.threadId ?? '',
        };
      } catch (err) {
        throw mapGmailError(err);
      }
    },
  };
}

// ── gmail_delete_message ──────────────────────────────────────────────────────

const DeleteMessageInput = z.object({
  message_id: z.string().describe('Gmail message ID to permanently delete.'),
});

export type DeleteMessageOutput = {
  deleted: boolean;
  messageId: string;
};

export function createDeleteMessageTool(
  gmail: gmail_v1.Gmail,
): ToolDefinition<typeof DeleteMessageInput, DeleteMessageOutput> {
  return {
    name: 'gmail_delete_message',
    description:
      'Permanently delete a Gmail message. This is irreversible — the message cannot be recovered. ' +
      'Consider gmail_trash_message for recoverable deletion.',
    inputSchema: DeleteMessageInput,
    riskLevel: 'destructive',
    async execute(input) {
      try {
        await gmail.users.messages.delete({
          userId: 'me',
          id: input.message_id,
        });
        return { deleted: true, messageId: input.message_id };
      } catch (err) {
        throw mapGmailError(err);
      }
    },
  };
}
