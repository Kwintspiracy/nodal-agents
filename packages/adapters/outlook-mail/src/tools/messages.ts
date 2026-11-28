// @nodal-agents/adapter-outlook-mail — message tools
// list, get, send, reply, forward, delete (move to Deleted Items), update (read/categories), move
//
// Send, reply and forward implement the mail contract of
// @nodal-agents/shared/mail-contract (#1191, #1192, #1193).

import { z } from 'zod';
import type { ConnectorToolDefinition } from '@nodal-agents/tools';
import type { Client } from '@microsoft/microsoft-graph-client';
import type { Attachment, Message, Recipient } from '@microsoft/microsoft-graph-types';
import {
  forwardSubject,
  mailBodyFormatSchema,
  parseMailAddressList,
  replySubject,
  resolveMailBodyFormat,
  resolveReplyRecipients,
} from '@nodal-agents/shared/mail-contract';
import type {
  MailAddress,
  MailAttachmentReport,
  MailSendReport,
} from '@nodal-agents/shared/mail-contract';
import { mapOutlookError, OutlookAdapterError } from '../errors';
import { paginateOutlook } from '../helpers/pagination';
import type { ODataListResponse } from '../helpers/pagination';
import { extractTextFromBody, capBody } from '../helpers/body';
import { buildFileAttachments, graphBody, toGraphRecipients } from '../helpers/message';
import { listOwnAddresses } from '../helpers/own-addresses';
import type { AttachmentSpec } from '../helpers/message';

// Max body chars to return (avoid context overload) — same cap as adapter-gmail.
const BODY_CHAR_CAP = 10000;

// ── Attachment schema (reused across send/reply/create-draft) ──────────────

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

const LIST_SELECT = [
  'id',
  'subject',
  'from',
  'receivedDateTime',
  'bodyPreview',
  'isRead',
  'hasAttachments',
  'parentFolderId',
];

// ── outlook_list_messages ───────────────────────────────────────────────────

const ListMessagesInput = z.object({
  folder: z
    .string()
    .optional()
    .describe(
      "Well-known folder name ('inbox', 'sentitems', 'drafts', 'deleteditems', 'junkemail', 'archive') " +
        'or a folder ID from outlook_list_folders. Omit to search across the whole mailbox.',
    ),
  query: z
    .string()
    .optional()
    .describe('Free-text search across subject/body/sender (Graph $search).'),
  filter: z
    .string()
    .optional()
    .describe(
      'Raw OData $filter expression, e.g. "isRead eq false". Cannot always be combined with query.',
    ),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe('Max messages to return (1-500, default 20).'),
});

export type ListMessagesOutput = {
  total: number;
  messages: Array<{
    messageId: string;
    from: string;
    subject: string;
    receivedDateTime: string;
    bodyPreview: string;
    isRead: boolean;
    hasAttachments: boolean;
    folderId: string;
  }>;
};

export function createListMessagesTool(
  client: Client,
): ConnectorToolDefinition<typeof ListMessagesInput, ListMessagesOutput> {
  return {
    name: 'outlook_list_messages',
    description:
      'List Outlook messages, optionally scoped to a folder and filtered by free-text search or an OData $filter ' +
      'expression. Returns message IDs, sender, subject, received date and a preview. ' +
      'Use outlook_get_message for the full body.',
    inputSchema: ListMessagesInput,
    async execute(input) {
      try {
        const maxResults = Math.min(input.max_results ?? 20, 500);
        const basePath = input.folder
          ? `/me/mailFolders/${encodeURIComponent(input.folder)}/messages`
          : '/me/messages';

        const items = await paginateOutlook<Message>(
          client,
          async () => {
            let req = client.api(basePath).select(LIST_SELECT).top(Math.min(maxResults, 100));
            if (input.query) req = req.search(`"${input.query.replace(/"/g, '\\"')}"`);
            if (input.filter) req = req.filter(input.filter);
            return (await req.get()) as ODataListResponse<Message>;
          },
          maxResults,
        );

        return {
          total: items.length,
          messages: items.map((m) => ({
            messageId: m.id ?? '',
            from: m.from?.emailAddress?.address ?? '',
            subject: m.subject ?? '',
            receivedDateTime: m.receivedDateTime ?? '',
            bodyPreview: m.bodyPreview ?? '',
            isRead: m.isRead ?? false,
            hasAttachments: m.hasAttachments ?? false,
            folderId: m.parentFolderId ?? '',
          })),
        };
      } catch (err) {
        throw mapOutlookError(err);
      }
    },
  };
}

// ── outlook_get_message ─────────────────────────────────────────────────────

const GetMessageInput = z.object({
  message_id: z.string().describe('Outlook message ID (from outlook_list_messages).'),
});

export type GetMessageOutput = {
  messageId: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  receivedDateTime: string;
  body: string;
  truncated: boolean;
  isRead: boolean;
  folderId: string;
  attachments: Array<{ attachmentId: string; filename: string; mimeType: string; size: number }>;
};

export function createGetMessageTool(
  client: Client,
): ConnectorToolDefinition<typeof GetMessageInput, GetMessageOutput> {
  return {
    name: 'outlook_get_message',
    description:
      'Get the full content of an Outlook message including decoded body and attachment metadata ' +
      '(not attachment content). Use outlook_get_attachment to download an attachment by its ID.',
    inputSchema: GetMessageInput,
    async execute(input) {
      try {
        const messageId = encodeURIComponent(input.message_id);
        const msg = (await client
          .api(`/me/messages/${messageId}`)
          .select([
            'id',
            'subject',
            'from',
            'toRecipients',
            'ccRecipients',
            'receivedDateTime',
            'body',
            'isRead',
            'parentFolderId',
            'hasAttachments',
          ])
          .get()) as Message;

        const { body, truncated } = capBody(extractTextFromBody(msg.body), BODY_CHAR_CAP);

        let attachments: GetMessageOutput['attachments'] = [];
        if (msg.hasAttachments) {
          const attRes = (await client
            .api(`/me/messages/${messageId}/attachments`)
            .select(['id', 'name', 'contentType', 'size'])
            .get()) as ODataListResponse<{
            id?: string;
            name?: string;
            contentType?: string;
            size?: number;
          }>;
          attachments = (attRes.value ?? []).map((a) => ({
            attachmentId: a.id ?? '',
            filename: a.name ?? '',
            mimeType: a.contentType ?? 'application/octet-stream',
            size: a.size ?? 0,
          }));
        }

        return {
          messageId: msg.id ?? '',
          from: msg.from?.emailAddress?.address ?? '',
          to: (msg.toRecipients ?? [])
            .map((r) => r.emailAddress?.address ?? '')
            .filter(Boolean)
            .join(', '),
          cc: (msg.ccRecipients ?? [])
            .map((r) => r.emailAddress?.address ?? '')
            .filter(Boolean)
            .join(', '),
          subject: msg.subject ?? '',
          receivedDateTime: msg.receivedDateTime ?? '',
          body,
          truncated,
          isRead: msg.isRead ?? false,
          folderId: msg.parentFolderId ?? '',
          attachments,
        };
      } catch (err) {
        throw mapOutlookError(err);
      }
    },
  };
}

// ── outlook_send_email ──────────────────────────────────────────────────────

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
  save_to_sent_items: z.boolean().optional().describe('Save a copy to Sent Items (default true).'),
});

export type SendEmailOutput = MailSendReport;

function reportAttachments(attachments: Attachment[]): MailAttachmentReport[] {
  return attachments.map((a) => ({
    filename: a.name ?? '',
    mimeType: a.contentType ?? 'application/octet-stream',
    inline: a.isInline ?? false,
  }));
}

export function createSendEmailTool(
  client: Client,
): ConnectorToolDefinition<typeof SendEmailInput, SendEmailOutput> {
  return {
    name: 'outlook_send_email',
    description:
      'Send an email via Outlook. The body is plain text unless body_format is html. Supports CC, BCC, ' +
      'Reply-To, and file attachments. Returns the recipients, subject and attachments actually sent ' +
      '(Graph returns no message id for a send).',
    inputSchema: SendEmailInput,
    async execute(input) {
      try {
        const bodyFormat = resolveMailBodyFormat(input.body_format);
        const to = parseMailAddressList(input.to);
        const cc = parseMailAddressList(input.cc);
        const bcc = parseMailAddressList(input.bcc);
        const attachments = buildFileAttachments(input.attachments as AttachmentSpec[] | undefined);
        const message: Message = {
          subject: input.subject,
          body: graphBody(input.body, bodyFormat),
          toRecipients: toGraphRecipients(to),
          ccRecipients: toGraphRecipients(cc),
          bccRecipients: toGraphRecipients(bcc),
          replyTo: toGraphRecipients(parseMailAddressList(input.reply_to)),
          attachments,
        };
        await client.api('/me/sendMail').post({
          message,
          saveToSentItems: input.save_to_sent_items ?? true,
        });
        return {
          sent: true,
          to,
          cc,
          bcc,
          subject: input.subject,
          bodyFormat,
          messageId: null,
          threadId: null,
          attachments: reportAttachments(attachments),
        };
      } catch (err) {
        throw mapOutlookError(err);
      }
    },
  };
}

// ── Draft-based reply and forward ───────────────────────────────────────────
//
// Graph's one-call `reply` "uses the sender of the original message as
// recipient", and its documentation leaves the Reply-To rule to the caller
// ("send the reply to the recipients in replyTo and not the recipient in the
// from property"). The contract's recipients are therefore set explicitly, on
// the draft Graph's own `createReply` / `createForward` prepare (threading and
// the carried original are Graph's), then sent with the draft's `send` action.
// A draft whose completion fails is deleted, and the error is raised: nothing
// half-written is left behind or reported as sent.

async function completeAndSendDraft(
  client: Client,
  draftId: string,
  patch: Partial<Message>,
  attachments: Attachment[],
): Promise<void> {
  const draftPath = `/me/messages/${encodeURIComponent(draftId)}`;
  try {
    await client.api(draftPath).patch(patch);
    for (const attachment of attachments) {
      await client.api(`${draftPath}/attachments`).post(attachment);
    }
    await client.api(`${draftPath}/send`).post({});
  } catch (err) {
    try {
      await client.api(draftPath).delete();
    } catch {
      // The send's error is the one the caller must see; a draft that could
      // not be removed stays in Drafts, where the person can see it.
    }
    throw err;
  }
}

function participants(list: Recipient[] | null | undefined): MailAddress[] {
  return (list ?? []).flatMap((r) => {
    const address = r.emailAddress?.address;
    if (!address) return [];
    const name = r.emailAddress?.name ?? '';
    return [name ? { name, address } : { address }];
  });
}

// ── outlook_reply_message ───────────────────────────────────────────────────

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

export function createReplyMessageTool(
  client: Client,
): ConnectorToolDefinition<typeof ReplyMessageInput, ReplyMessageOutput> {
  return {
    name: 'outlook_reply_message',
    description:
      'Reply to an Outlook message in its conversation. The recipients are resolved the way a mail client ' +
      "does: the message's Reply-To, else its sender; a reply to a message this mailbox sent goes to that " +
      "message's recipients; reply_all adds the other participants. Returns the recipients actually used.",
    inputSchema: ReplyMessageInput,
    async execute(input) {
      try {
        const bodyFormat = resolveMailBodyFormat(input.body_format);
        const messagePath = `/me/messages/${encodeURIComponent(input.message_id)}`;
        const original = (await client
          .api(messagePath)
          .select([
            'id',
            'subject',
            'from',
            'replyTo',
            'toRecipients',
            'ccRecipients',
            'conversationId',
          ])
          .get()) as Message;

        const recipients = resolveReplyRecipients(
          {
            from: participants(original.from ? [original.from] : []),
            replyTo: participants(original.replyTo),
            to: participants(original.toRecipients),
            cc: participants(original.ccRecipients),
          },
          await listOwnAddresses(client),
          input.reply_all ?? false,
        );
        const cc = [...recipients.cc, ...parseMailAddressList(input.cc)];
        const subject = replySubject(original.subject ?? '');
        const attachments = buildFileAttachments(input.attachments as AttachmentSpec[] | undefined);

        const draft = (await client.api(`${messagePath}/createReply`).post({})) as Message;
        if (!draft.id) {
          throw new OutlookAdapterError(
            'outlook_unknown',
            'Graph created no reply draft: nothing was sent.',
          );
        }
        await completeAndSendDraft(
          client,
          draft.id,
          {
            subject,
            toRecipients: toGraphRecipients(recipients.to),
            ccRecipients: toGraphRecipients(cc),
            body: graphBody(input.body, bodyFormat),
          },
          attachments,
        );
        return {
          sent: true,
          to: recipients.to,
          cc,
          bcc: [],
          subject,
          bodyFormat,
          messageId: null,
          threadId: draft.conversationId ?? original.conversationId ?? null,
          attachments: reportAttachments(attachments),
        };
      } catch (err) {
        throw mapOutlookError(err);
      }
    },
  };
}

// ── outlook_forward_message ─────────────────────────────────────────────────

const ForwardMessageInput = z.object({
  message_id: z.string().describe('ID of the message to forward.'),
  to: z.string().describe('Recipient address list.'),
  note: z
    .string()
    .optional()
    .describe('Optional plain-text note sent above the forwarded message.'),
  cc: z.string().optional().describe('CC address list.'),
});

export type ForwardMessageOutput = MailSendReport;

export function createForwardMessageTool(
  client: Client,
): ConnectorToolDefinition<typeof ForwardMessageInput, ForwardMessageOutput> {
  return {
    name: 'outlook_forward_message',
    description:
      'Forward an Outlook message to new recipients, with an optional note. Graph carries the original ' +
      'whole (its body, attachments and inline images). Returns the recipients and the files the ' +
      'forwarded original carried.',
    inputSchema: ForwardMessageInput,
    async execute(input) {
      try {
        const to = parseMailAddressList(input.to);
        const cc = parseMailAddressList(input.cc);
        const messagePath = `/me/messages/${encodeURIComponent(input.message_id)}`;
        const original = (await client
          .api(messagePath)
          .select(['id', 'subject', 'hasAttachments'])
          .get()) as Message;
        const carried = original.hasAttachments
          ? ((
              (await client
                .api(`${messagePath}/attachments`)
                .select(['id', 'name', 'contentType', 'isInline'])
                .get()) as ODataListResponse<Attachment>
            ).value ?? [])
          : [];
        const subject = forwardSubject(original.subject ?? '');

        // Graph's createForward prepares the forward with the original's body
        // and attachments; the note is its `comment`. The body is never
        // replaced, so the original stays whole.
        const draft = (await client
          .api(`${messagePath}/createForward`)
          .post({ comment: input.note ?? '' })) as Message;
        if (!draft.id) {
          throw new OutlookAdapterError(
            'outlook_unknown',
            'Graph created no forward draft: nothing was sent.',
          );
        }
        await completeAndSendDraft(
          client,
          draft.id,
          { subject, toRecipients: toGraphRecipients(to), ccRecipients: toGraphRecipients(cc) },
          [],
        );
        return {
          sent: true,
          to,
          cc,
          bcc: [],
          subject,
          bodyFormat: 'text',
          messageId: null,
          threadId: null,
          attachments: [],
          forwarded: { messageId: input.message_id, attachments: reportAttachments(carried) },
        };
      } catch (err) {
        throw mapOutlookError(err);
      }
    },
  };
}

// ── outlook_delete_message (move to Deleted Items) ──────────────────────────

const DeleteMessageInput = z.object({
  message_id: z.string().describe('Outlook message ID to move to the Deleted Items folder.'),
});

export type DeleteMessageOutput = { deleted: boolean; messageId: string; newMessageId: string };

export function createDeleteMessageTool(
  client: Client,
): ConnectorToolDefinition<typeof DeleteMessageInput, DeleteMessageOutput> {
  return {
    name: 'outlook_delete_message',
    description:
      'Move an Outlook message to the Deleted Items folder. Recoverable — this does not permanently erase the ' +
      'message. Moving a message assigns it a new ID; that new ID is returned.',
    inputSchema: DeleteMessageInput,
    async execute(input) {
      try {
        const moved = (await client
          .api(`/me/messages/${encodeURIComponent(input.message_id)}/move`)
          .post({ destinationId: 'deleteditems' })) as Message;
        return { deleted: true, messageId: input.message_id, newMessageId: moved.id ?? '' };
      } catch (err) {
        throw mapOutlookError(err);
      }
    },
  };
}

// ── outlook_update_message ──────────────────────────────────────────────────

const UpdateMessageInput = z.object({
  message_id: z.string().describe('Outlook message ID.'),
  is_read: z.boolean().optional().describe('Mark the message as read (true) or unread (false).'),
  categories: z
    .array(z.string())
    .optional()
    .describe(
      'Full replacement list of Outlook categories for this message (Outlook has no add/remove — this replaces the set).',
    ),
});

export type UpdateMessageOutput = { messageId: string; isRead: boolean; categories: string[] };

export function createUpdateMessageTool(
  client: Client,
): ConnectorToolDefinition<typeof UpdateMessageInput, UpdateMessageOutput> {
  return {
    name: 'outlook_update_message',
    description:
      "Update an Outlook message's read status and/or categories (Outlook's closest equivalent to Gmail labels). " +
      'categories, when provided, REPLACES the full set — Graph has no separate add/remove.',
    inputSchema: UpdateMessageInput,
    async execute(input) {
      try {
        if (input.is_read === undefined && input.categories === undefined) {
          throw new OutlookAdapterError(
            'outlook_validation_error',
            'Provide at least one of is_read or categories.',
          );
        }
        const patch: Partial<Message> = {};
        if (input.is_read !== undefined) patch.isRead = input.is_read;
        if (input.categories !== undefined) patch.categories = input.categories;

        const updated = (await client
          .api(`/me/messages/${encodeURIComponent(input.message_id)}`)
          .patch(patch)) as Message;
        return {
          messageId: updated.id ?? input.message_id,
          isRead: updated.isRead ?? false,
          categories: updated.categories ?? [],
        };
      } catch (err) {
        throw mapOutlookError(err);
      }
    },
  };
}

// ── outlook_move_message ────────────────────────────────────────────────────

const MoveMessageInput = z.object({
  message_id: z.string().describe('Outlook message ID to move.'),
  destination_folder_id: z
    .string()
    .describe(
      "Target folder ID (from outlook_list_folders) or a well-known name like 'archive', 'inbox'.",
    ),
});

export type MoveMessageOutput = {
  messageId: string;
  newMessageId: string;
  destinationFolderId: string;
};

export function createMoveMessageTool(
  client: Client,
): ConnectorToolDefinition<typeof MoveMessageInput, MoveMessageOutput> {
  return {
    name: 'outlook_move_message',
    description:
      'Move an Outlook message to a different mail folder. Moving assigns the message a new ID, which is returned.',
    inputSchema: MoveMessageInput,
    async execute(input) {
      try {
        const moved = (await client
          .api(`/me/messages/${encodeURIComponent(input.message_id)}/move`)
          .post({ destinationId: input.destination_folder_id })) as Message;
        return {
          messageId: input.message_id,
          newMessageId: moved.id ?? '',
          destinationFolderId: input.destination_folder_id,
        };
      } catch (err) {
        throw mapOutlookError(err);
      }
    },
  };
}
