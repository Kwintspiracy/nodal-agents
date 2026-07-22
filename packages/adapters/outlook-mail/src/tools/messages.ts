// @nodal-agents/adapter-outlook-mail — message tools
// list, get, send, reply, forward, delete (move to Deleted Items), update (read/categories), move

import { z } from 'zod';
import type { ToolDefinition } from '@nodal-agents/tools';
import type { Client } from '@microsoft/microsoft-graph-client';
import type { Message } from '@microsoft/microsoft-graph-types';
import { mapOutlookError, OutlookAdapterError } from '../errors';
import { paginateOutlook } from '../helpers/pagination';
import type { ODataListResponse } from '../helpers/pagination';
import { extractTextFromBody, capBody } from '../helpers/body';
import { parseRecipients, buildFileAttachments, detectBodyContentType } from '../helpers/message';
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
): ToolDefinition<typeof ListMessagesInput, ListMessagesOutput> {
  return {
    name: 'outlook_list_messages',
    description:
      'List Outlook messages, optionally scoped to a folder and filtered by free-text search or an OData $filter ' +
      'expression. Returns message IDs, sender, subject, received date and a preview. ' +
      'Use outlook_get_message for the full body.',
    inputSchema: ListMessagesInput,
    riskLevel: 'read',
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
): ToolDefinition<typeof GetMessageInput, GetMessageOutput> {
  return {
    name: 'outlook_get_message',
    description:
      'Get the full content of an Outlook message including decoded body and attachment metadata ' +
      '(not attachment content). Use outlook_get_attachment to download an attachment by its ID.',
    inputSchema: GetMessageInput,
    riskLevel: 'read',
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
  to: z.string().describe('Recipient email address or comma-separated list.'),
  subject: z.string().describe('Email subject line.'),
  body: z.string().describe('Email body — plain text or HTML.'),
  cc: z.string().optional().describe('CC address(es), comma-separated.'),
  bcc: z.string().optional().describe('BCC address(es), comma-separated.'),
  reply_to: z.string().optional().describe('Reply-To address(es), comma-separated.'),
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

export type SendEmailOutput = { sent: boolean };

export function createSendEmailTool(
  client: Client,
): ToolDefinition<typeof SendEmailInput, SendEmailOutput> {
  return {
    name: 'outlook_send_email',
    description:
      'Send an email via Outlook. Supports plain text and HTML bodies, CC, BCC, Reply-To, and file attachments. ' +
      'The Microsoft Graph sendMail action does not return the created message — there is no messageId to report back.',
    inputSchema: SendEmailInput,
    riskLevel: 'destructive',
    async execute(input) {
      try {
        const message: Message = {
          subject: input.subject,
          body: { contentType: detectBodyContentType(input.body), content: input.body },
          toRecipients: parseRecipients(input.to),
          ccRecipients: parseRecipients(input.cc),
          bccRecipients: parseRecipients(input.bcc),
          replyTo: parseRecipients(input.reply_to),
          attachments: buildFileAttachments(input.attachments as AttachmentSpec[] | undefined),
        };
        await client.api('/me/sendMail').post({
          message,
          saveToSentItems: input.save_to_sent_items ?? true,
        });
        return { sent: true };
      } catch (err) {
        throw mapOutlookError(err);
      }
    },
  };
}

// ── outlook_reply_message ───────────────────────────────────────────────────

const ReplyMessageInput = z.object({
  message_id: z.string().describe('ID of the message to reply to.'),
  comment: z.string().describe('Reply text, prepended above the quoted original message.'),
  reply_all: z
    .boolean()
    .optional()
    .describe('Reply to all recipients instead of just the sender (default false).'),
});

export type ReplyMessageOutput = { sent: boolean; replyAll: boolean };

export function createReplyMessageTool(
  client: Client,
): ToolDefinition<typeof ReplyMessageInput, ReplyMessageOutput> {
  return {
    name: 'outlook_reply_message',
    description:
      'Reply to an Outlook message in-thread. Set reply_all to reply to every recipient instead of just the sender. ' +
      'Graph automatically quotes the original message and sets threading — this action returns no messageId.',
    inputSchema: ReplyMessageInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        const action = input.reply_all ? 'replyAll' : 'reply';
        await client.api(`/me/messages/${encodeURIComponent(input.message_id)}/${action}`).post({
          comment: input.comment,
        });
        return { sent: true, replyAll: input.reply_all ?? false };
      } catch (err) {
        throw mapOutlookError(err);
      }
    },
  };
}

// ── outlook_forward_message ─────────────────────────────────────────────────

const ForwardMessageInput = z.object({
  message_id: z.string().describe('ID of the message to forward.'),
  to: z.string().describe('Recipient(s), comma-separated.'),
  comment: z.string().optional().describe('Optional note prepended before the forwarded message.'),
});

export type ForwardMessageOutput = { sent: boolean };

export function createForwardMessageTool(
  client: Client,
): ToolDefinition<typeof ForwardMessageInput, ForwardMessageOutput> {
  return {
    name: 'outlook_forward_message',
    description: 'Forward an Outlook message to new recipients, with an optional note.',
    inputSchema: ForwardMessageInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        await client.api(`/me/messages/${encodeURIComponent(input.message_id)}/forward`).post({
          comment: input.comment ?? '',
          toRecipients: parseRecipients(input.to),
        });
        return { sent: true };
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
): ToolDefinition<typeof DeleteMessageInput, DeleteMessageOutput> {
  return {
    name: 'outlook_delete_message',
    description:
      'Move an Outlook message to the Deleted Items folder. Recoverable — this does not permanently erase the ' +
      'message. Moving a message assigns it a new ID; that new ID is returned.',
    inputSchema: DeleteMessageInput,
    riskLevel: 'write',
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
): ToolDefinition<typeof UpdateMessageInput, UpdateMessageOutput> {
  return {
    name: 'outlook_update_message',
    description:
      "Update an Outlook message's read status and/or categories (Outlook's closest equivalent to Gmail labels). " +
      'categories, when provided, REPLACES the full set — Graph has no separate add/remove.',
    inputSchema: UpdateMessageInput,
    riskLevel: 'write',
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
): ToolDefinition<typeof MoveMessageInput, MoveMessageOutput> {
  return {
    name: 'outlook_move_message',
    description:
      'Move an Outlook message to a different mail folder. Moving assigns the message a new ID, which is returned.',
    inputSchema: MoveMessageInput,
    riskLevel: 'write',
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
