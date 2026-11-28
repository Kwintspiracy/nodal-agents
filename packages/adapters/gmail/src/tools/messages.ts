// @nodal-agents/adapter-gmail — message tools
// send, list, get, reply, modify-labels, forward, trash, untrash, delete
//
// Send, reply and forward implement the mail contract of
// @nodal-agents/shared/mail-contract (#1191, #1192, #1193): the body's type is
// declared, a reply goes where a mail client sends it, a forward carries the
// original whole, and each returns what it did.

import { z } from 'zod';
import type { ConnectorToolDefinition } from '@nodal-agents/tools';
import type { gmail_v1 } from 'googleapis';
import {
  forwardSubject,
  mailBodyFormatSchema,
  parseMailAddressList,
  replySubject,
  resolveMailBodyFormat,
  resolveReplyRecipients,
} from '@nodal-agents/shared/mail-contract';
import type { MailAttachmentReport, MailSendReport } from '@nodal-agents/shared/mail-contract';
import { mapGmailError, GmailAdapterError } from '../errors';
import { paginateGmail } from '../helpers/pagination';
import { mapWithConcurrency } from '../helpers/concurrency';
import {
  extractTextFromPayload,
  extractAttachmentInfos,
  extractCarriedFiles,
  parseGmailHeaders,
} from '../helpers/parse-payload';
import {
  attachmentSpecsToMime,
  buildMimeMessage,
  toGmailRaw,
  type AttachmentSpec,
  type MimeAttachment,
} from '../helpers/mime';
import { listOwnAddresses } from '../helpers/own-addresses';

// Max body chars to return (avoid context overload)
const BODY_CHAR_CAP = 10000;

// audit#2026-07-07 F3: cap how many per-message GET requests run at once when
// hydrating a list page (up to 500 stubs) — an unbounded Promise.all fan-out
// hits Gmail's rate limit and spikes memory for large pages.
const HYDRATE_CONCURRENCY = 15;

// ── Attachment schema (reused across send/reply/draft) ─────────────────────

export const AttachmentItemSchema = z.object({
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

function reportAttachments(parts: MimeAttachment[]): MailAttachmentReport[] {
  return parts.map((p) => ({ filename: p.filename, mimeType: p.contentType, inline: false }));
}

// ── gmail_send_email ──────────────────────────────────────────────────────────

const SendEmailInput = z.object({
  to: z
    .string()
    .describe('Recipient(s): an address list, e.g. "Jane Doe <jane@x.com>, bob@y.com".'),
  subject: z.string().describe('Email subject line.'),
  body: z
    .string()
    .describe('Email body, sent exactly as written, in the format given by body_format.'),
  body_format: mailBodyFormatSchema,
  cc: z.string().optional().describe('CC address list.'),
  bcc: z.string().optional().describe('BCC address list.'),
  reply_to: z.string().optional().describe('Reply-To address list.'),
  attachments: z
    .array(AttachmentItemSchema)
    .optional()
    .describe(
      'Optional file attachments. Each item: {filename, content, mimeType?, encoding?}. ' +
        "Default encoding is 'text' — pass the file content as a plain string. " +
        "Use encoding='base64' only when you hold pre-encoded binary content.",
    ),
});

export type SendEmailOutput = MailSendReport;

export function createSendEmailTool(
  gmail: gmail_v1.Gmail,
): ConnectorToolDefinition<typeof SendEmailInput, SendEmailOutput> {
  return {
    name: 'gmail_send_email',
    description:
      'Send an email via Gmail. The body is plain text unless body_format is html. Supports CC, BCC, ' +
      'Reply-To, and file attachments. Returns the recipients, subject and attachments actually sent.',
    inputSchema: SendEmailInput,
    async execute(input) {
      try {
        const bodyFormat = resolveMailBodyFormat(input.body_format);
        const to = parseMailAddressList(input.to);
        const cc = parseMailAddressList(input.cc);
        const bcc = parseMailAddressList(input.bcc);
        const attachments = attachmentSpecsToMime(
          input.attachments as AttachmentSpec[] | undefined,
        );
        const message = await buildMimeMessage({
          to,
          cc,
          bcc,
          replyTo: parseMailAddressList(input.reply_to),
          subject: input.subject,
          body: input.body,
          bodyFormat,
          attachments,
        });
        const res = await gmail.users.messages.send({
          userId: 'me',
          requestBody: { raw: toGmailRaw(message) },
        });
        return {
          sent: true,
          to,
          cc,
          bcc,
          subject: input.subject,
          bodyFormat,
          messageId: res.data.id ?? null,
          threadId: res.data.threadId ?? null,
          attachments: reportAttachments(attachments),
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
  /** Count of stubs whose metadata GET failed (audit#2026-07-07 F3) — see each message's `error`. */
  errors: number;
  messages: Array<{
    messageId: string;
    threadId: string;
    from: string;
    subject: string;
    date: string;
    snippet: string;
    labelIds: string[];
    /** Set when the metadata GET for this message failed — fields above are blank, not real data. */
    error?: string;
  }>;
};

export function createListMessagesTool(
  gmail: gmail_v1.Gmail,
): ConnectorToolDefinition<typeof ListMessagesInput, ListMessagesOutput> {
  return {
    name: 'gmail_list_messages',
    description:
      'List Gmail messages matching a query. Returns message IDs, thread IDs, sender, subject, date and snippet. ' +
      'Use gmail_get_message to read the full body, or gmail_get_thread for the full conversation.',
    inputSchema: ListMessagesInput,
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

        // Fetch metadata for each message (Subject, From, Date). Bounded
        // concurrency (F3) — up to 500 stubs would otherwise fan out 500
        // simultaneous GETs — and a failed fetch is reported via `error`
        // rather than a blank-field stub indistinguishable from a real (if
        // empty) message.
        const detailed = await mapWithConcurrency(messages, HYDRATE_CONCURRENCY, async (stub) => {
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
          } catch (err) {
            return {
              messageId: stub.id ?? '',
              threadId: stub.threadId ?? '',
              from: '',
              subject: '',
              date: '',
              snippet: '',
              labelIds: [],
              error: err instanceof Error ? err.message : 'gmail_get_message_failed',
            };
          }
        });

        const errors = detailed.filter((m) => m.error !== undefined).length;
        return { total: detailed.length, errors, messages: detailed };
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
): ConnectorToolDefinition<typeof GetMessageInput, GetMessageOutput> {
  return {
    name: 'gmail_get_message',
    description:
      'Get the full content of a Gmail message including decoded body and attachment metadata. ' +
      'Use gmail_get_attachment to download an attachment by its ID.',
    inputSchema: GetMessageInput,
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
  body: z
    .string()
    .describe('Reply body, sent exactly as written, in the format given by body_format.'),
  body_format: mailBodyFormatSchema,
  reply_all: z
    .boolean()
    .optional()
    .describe(
      'Reply to every participant (the sender and the other To/Cc recipients) instead of only the sender ' +
        '(default false). This mailbox is never among the recipients.',
    ),
  cc: z
    .string()
    .optional()
    .describe('Extra CC address list, added to the recipients the reply resolves.'),
  attachments: z
    .array(AttachmentItemSchema)
    .optional()
    .describe('Optional attachments to include with the reply.'),
});

export type ReplyMessageOutput = MailSendReport;

/** Message-IDs listed in a References / In-Reply-To / Message-ID header, in order. */
function messageIdList(value: string | undefined): string[] {
  return (value ?? '').match(/<[^<>\s]+>/g) ?? [];
}

export function createReplyMessageTool(
  gmail: gmail_v1.Gmail,
): ConnectorToolDefinition<typeof ReplyMessageInput, ReplyMessageOutput> {
  return {
    name: 'gmail_reply_message',
    description:
      'Reply to a Gmail message in its thread. The recipients are resolved the way a mail client does: ' +
      "the message's Reply-To, else its sender; a reply to a message this mailbox sent goes to that " +
      "message's recipients; reply_all adds the other participants. Returns the recipients actually used.",
    inputSchema: ReplyMessageInput,
    async execute(input) {
      try {
        const bodyFormat = resolveMailBodyFormat(input.body_format);
        const metaRes = await gmail.users.messages.get({
          userId: 'me',
          id: input.message_id,
          format: 'metadata',
          metadataHeaders: ['Subject', 'From', 'Reply-To', 'To', 'Cc', 'Message-ID', 'References'],
        });
        const meta = metaRes.data;
        const headers = parseGmailHeaders(meta.payload ?? undefined);
        const threadId = meta.threadId ?? null;

        const recipients = resolveReplyRecipients(
          {
            from: parseMailAddressList(headers['from']),
            replyTo: parseMailAddressList(headers['reply-to']),
            to: parseMailAddressList(headers['to']),
            cc: parseMailAddressList(headers['cc']),
          },
          await listOwnAddresses(gmail),
          input.reply_all ?? false,
        );
        const cc = [...recipients.cc, ...parseMailAddressList(input.cc)];

        // Threading (Gmail "Managing threads"): the threadId on the message
        // resource, References and In-Reply-To set per RFC 2822, and a
        // matching Subject.
        const subject = replySubject(headers['subject'] ?? '');
        const originalMsgId = messageIdList(headers['message-id'])[0];
        const references = messageIdList(headers['references']);
        if (originalMsgId && !references.includes(originalMsgId)) references.push(originalMsgId);

        const attachments = attachmentSpecsToMime(
          input.attachments as AttachmentSpec[] | undefined,
        );
        const message = await buildMimeMessage({
          to: recipients.to,
          cc,
          subject,
          body: input.body,
          bodyFormat,
          ...(originalMsgId ? { inReplyTo: originalMsgId } : {}),
          references,
          attachments,
        });

        const sendBody: gmail_v1.Schema$Message = { raw: toGmailRaw(message) };
        if (threadId) sendBody.threadId = threadId;

        const res = await gmail.users.messages.send({
          userId: 'me',
          requestBody: sendBody,
        });
        return {
          sent: true,
          to: recipients.to,
          cc,
          bcc: [],
          subject,
          bodyFormat,
          messageId: res.data.id ?? null,
          threadId: res.data.threadId ?? threadId,
          attachments: reportAttachments(attachments),
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
  to: z.string().describe('Recipient address list.'),
  note: z
    .string()
    .optional()
    .describe('Optional plain-text note sent above the forwarded message, exactly as written.'),
  cc: z.string().optional().describe('CC address list.'),
});

export type ForwardMessageOutput = MailSendReport;

/** A file name for the attached original: its subject, made safe for a file name. */
function originalFileName(subject: string): string {
  const base = subject
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 120);
  return `${base || 'message'}.eml`;
}

export function createForwardMessageTool(
  gmail: gmail_v1.Gmail,
): ConnectorToolDefinition<typeof ForwardMessageInput, ForwardMessageOutput> {
  return {
    name: 'gmail_forward_message',
    description:
      'Forward a Gmail message to new recipients. The original message is carried whole, as an attached ' +
      'message (its body as it was, its attachments and inline images), with an optional note above it. ' +
      'Returns the recipients and the files the forwarded original carried.',
    inputSchema: ForwardMessageInput,
    async execute(input) {
      try {
        const to = parseMailAddressList(input.to);
        const cc = parseMailAddressList(input.cc);

        // The original's structure (to report what it carries) and its exact
        // bytes (to carry it): Gmail's `raw` format is the message as stored.
        const [full, rawRes] = await Promise.all([
          gmail.users.messages.get({ userId: 'me', id: input.message_id, format: 'full' }),
          gmail.users.messages.get({ userId: 'me', id: input.message_id, format: 'raw' }),
        ]);
        const raw = rawRes.data.raw;
        if (!raw) {
          throw new GmailAdapterError(
            'gmail_forward_unavailable',
            `Gmail returned no content for message ${input.message_id}: nothing was forwarded.`,
          );
        }
        const payload = full.data.payload ?? undefined;
        const headers = parseGmailHeaders(payload);
        const subject = forwardSubject(headers['subject'] ?? '');

        // RFC 2046 §5.2.1: an encapsulated message is a message/rfc822 part.
        const message = await buildMimeMessage({
          to,
          cc,
          subject,
          body: input.note ?? '',
          bodyFormat: 'text',
          attachments: [
            {
              filename: originalFileName(headers['subject'] ?? ''),
              contentType: 'message/rfc822',
              content: Buffer.from(raw, 'base64url'),
              transferEncoding: '8bit',
            },
          ],
        });

        const res = await gmail.users.messages.send({
          userId: 'me',
          requestBody: { raw: toGmailRaw(message) },
        });
        return {
          sent: true,
          to,
          cc,
          bcc: [],
          subject,
          bodyFormat: 'text',
          messageId: res.data.id ?? null,
          threadId: res.data.threadId ?? null,
          attachments: [],
          forwarded: {
            messageId: input.message_id,
            attachments: extractCarriedFiles(payload),
          },
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
): ConnectorToolDefinition<typeof ModifyLabelsInput, ModifyLabelsOutput> {
  return {
    name: 'gmail_modify_labels',
    description:
      'Add or remove labels on a Gmail message. System labels: INBOX, UNREAD, STARRED, IMPORTANT, TRASH, SPAM. ' +
      'Use to mark as read (remove UNREAD), star, archive (remove INBOX), etc.',
    inputSchema: ModifyLabelsInput,
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
): ConnectorToolDefinition<typeof TrashMessageInput, TrashMessageOutput> {
  return {
    name: 'gmail_trash_message',
    description:
      'Move a Gmail message to the Trash folder. Recoverable for 30 days. Prefer this over permanent delete.',
    inputSchema: TrashMessageInput,
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
): ConnectorToolDefinition<typeof UntrashMessageInput, UntrashMessageOutput> {
  return {
    name: 'gmail_untrash_message',
    description: 'Restore a Gmail message from the Trash folder.',
    inputSchema: UntrashMessageInput,
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
): ConnectorToolDefinition<typeof DeleteMessageInput, DeleteMessageOutput> {
  return {
    name: 'gmail_delete_message',
    description:
      'Permanently delete a Gmail message. This is irreversible — the message cannot be recovered. ' +
      'Consider gmail_trash_message for recoverable deletion.',
    inputSchema: DeleteMessageInput,
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
