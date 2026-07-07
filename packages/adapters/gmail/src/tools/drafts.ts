// @nodal-agents/adapter-gmail — draft tools
// list, create, update, send, delete

import { z } from 'zod';
import type { ToolDefinition } from '@nodal-agents/tools';
import type { gmail_v1 } from 'googleapis';
import { mapGmailError } from '../errors';
import { paginateGmail } from '../helpers/pagination';
import { mapWithConcurrency } from '../helpers/concurrency';
import { parseGmailHeaders } from '../helpers/parse-payload';
import { buildRfc2822Message } from '../helpers/rfc2822';
import type { AttachmentSpec } from '../helpers/rfc2822';

// audit#2026-07-07 F3: cap how many per-draft GET requests run at once when
// hydrating a list page (up to 500 stubs) — an unbounded Promise.all fan-out
// hits Gmail's rate limit and spikes memory for large pages.
const HYDRATE_CONCURRENCY = 15;

// ── Attachment schema ─────────────────────────────────────────────────────────

const AttachmentItemSchema = z.object({
  filename: z.string().describe("File name shown in the email, e.g. 'report.html'."),
  content: z.string().describe('File content as a string (plain text by default).'),
  mimeType: z.string().optional().describe('MIME type. Inferred from filename if omitted.'),
  encoding: z
    .enum(['text', 'base64'])
    .optional()
    .describe("'text' (default) or 'base64' for binaries."),
});

// ── gmail_list_drafts ─────────────────────────────────────────────────────────

const ListDraftsInput = z.object({
  max_results: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe('Max drafts to return (default 20).'),
  query: z.string().optional().describe('Optional Gmail search query.'),
});

export type ListDraftsOutput = {
  total: number;
  /** Count of stubs whose metadata GET failed (audit#2026-07-07 F3) — see each draft's `error`. */
  errors: number;
  drafts: Array<{
    draftId: string;
    messageId: string;
    to: string;
    subject: string;
    snippet: string;
    /** Set when the metadata GET for this draft failed — fields above are blank, not real data. */
    error?: string;
  }>;
};

export function createListDraftsTool(
  gmail: gmail_v1.Gmail,
): ToolDefinition<typeof ListDraftsInput, ListDraftsOutput> {
  return {
    name: 'gmail_list_drafts',
    description:
      'List Gmail drafts with their IDs, subjects and snippets. ' +
      'Use draft_id with gmail_send_draft to send or gmail_update_draft to edit.',
    inputSchema: ListDraftsInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const maxResults = Math.min(input.max_results ?? 20, 500);

        const draftStubs = await paginateGmail<gmail_v1.Schema$Draft>(
          async (pageToken, pageSize) => {
            const params: gmail_v1.Params$Resource$Users$Drafts$List = {
              userId: 'me',
              maxResults: pageSize,
              ...(pageToken && { pageToken }),
              ...(input.query && { q: input.query }),
            };
            const res = await gmail.users.drafts.list(params);
            return {
              items: res.data.drafts ?? [],
              nextPageToken: res.data.nextPageToken,
            };
          },
          Math.min(maxResults, 100),
          maxResults,
        );

        // Fetch metadata for each draft. Bounded concurrency (F3) — up to 500
        // stubs would otherwise fan out 500 simultaneous GETs — and a failed
        // fetch is reported via `error` rather than a blank-field stub
        // indistinguishable from a real (if empty) draft.
        const drafts = await mapWithConcurrency(draftStubs, HYDRATE_CONCURRENCY, async (stub) => {
          const draftId = stub.id ?? '';
          try {
            const res = await gmail.users.drafts.get({
              userId: 'me',
              id: draftId,
              format: 'metadata',
            });
            const msg = res.data.message ?? {};
            const headers = parseGmailHeaders(msg.payload ?? undefined);
            return {
              draftId,
              messageId: msg.id ?? '',
              to: headers['to'] ?? '',
              subject: headers['subject'] ?? '',
              snippet: msg.snippet ?? '',
            };
          } catch (err) {
            return {
              draftId,
              messageId: stub.message?.id ?? '',
              to: '',
              subject: '',
              snippet: '',
              error: err instanceof Error ? err.message : 'gmail_get_draft_failed',
            };
          }
        });

        const errors = drafts.filter((d) => d.error !== undefined).length;
        return { total: drafts.length, errors, drafts };
      } catch (err) {
        throw mapGmailError(err);
      }
    },
  };
}

// ── gmail_create_draft ────────────────────────────────────────────────────────

const CreateDraftInput = z.object({
  to: z.string().describe('Recipient email address.'),
  subject: z.string().describe('Email subject line.'),
  body: z.string().describe('Email body — plain text or HTML.'),
  cc: z.string().optional().describe('CC address(es), comma-separated.'),
  bcc: z.string().optional().describe('BCC address(es), comma-separated.'),
  reply_to_message_id: z
    .string()
    .optional()
    .describe('If provided, sets In-Reply-To and threadId so this draft is a reply in-thread.'),
  attachments: z.array(AttachmentItemSchema).optional().describe('Optional file attachments.'),
});

export type CreateDraftOutput = {
  draftId: string;
  messageId: string;
};

export function createCreateDraftTool(
  gmail: gmail_v1.Gmail,
): ToolDefinition<typeof CreateDraftInput, CreateDraftOutput> {
  return {
    name: 'gmail_create_draft',
    description:
      'Create a draft email in Gmail (not sent). ' +
      'Use reply_to_message_id to create a reply draft in-thread with correct threading headers.',
    inputSchema: CreateDraftInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        let threadId: string | undefined;
        let inReplyTo: string | undefined;
        let references: string | undefined;
        let subject = input.subject;

        if (input.reply_to_message_id) {
          const metaRes = await gmail.users.messages.get({
            userId: 'me',
            id: input.reply_to_message_id,
            format: 'metadata',
            metadataHeaders: ['Subject', 'Message-ID', 'Message-Id', 'References'],
          });
          const meta = metaRes.data;
          threadId = meta.threadId ?? undefined;
          const headers = parseGmailHeaders(meta.payload ?? undefined);
          const origSubject = headers['subject'] ?? '';
          if (origSubject && !subject.toLowerCase().startsWith('re:')) {
            subject = origSubject.toLowerCase().startsWith('re:')
              ? origSubject
              : `Re: ${origSubject}`;
          }
          const originalMsgId = headers['message-id'] ?? '';
          const priorRefs = headers['references'] ?? '';
          inReplyTo = originalMsgId || undefined;
          references = originalMsgId
            ? priorRefs
              ? `${priorRefs} ${originalMsgId}`
              : originalMsgId
            : priorRefs || undefined;
        }

        const raw = buildRfc2822Message({
          to: input.to,
          subject,
          body: input.body,
          cc: input.cc,
          bcc: input.bcc,
          inReplyTo,
          references,
          attachments: input.attachments as AttachmentSpec[] | undefined,
        });

        const requestBody: gmail_v1.Schema$Draft = {
          message: { raw, ...(threadId && { threadId }) },
        };

        const res = await gmail.users.drafts.create({
          userId: 'me',
          requestBody,
        });
        return {
          draftId: res.data.id ?? '',
          messageId: res.data.message?.id ?? '',
        };
      } catch (err) {
        throw mapGmailError(err);
      }
    },
  };
}

// ── gmail_update_draft ────────────────────────────────────────────────────────

const UpdateDraftInput = z.object({
  draft_id: z
    .string()
    .describe('Draft ID to update (from gmail_list_drafts or gmail_create_draft).'),
  to: z.string().describe('Recipient email address.'),
  subject: z.string().describe('Email subject line.'),
  body: z.string().describe('Email body — plain text or HTML.'),
  cc: z.string().optional().describe('CC address(es), comma-separated.'),
  bcc: z.string().optional().describe('BCC address(es), comma-separated.'),
  attachments: z.array(AttachmentItemSchema).optional().describe('Optional file attachments.'),
});

export type UpdateDraftOutput = {
  draftId: string;
  messageId: string;
};

export function createUpdateDraftTool(
  gmail: gmail_v1.Gmail,
): ToolDefinition<typeof UpdateDraftInput, UpdateDraftOutput> {
  return {
    name: 'gmail_update_draft',
    description:
      'Overwrite an existing Gmail draft with new content. ' +
      'Use this to revise a draft before sending.',
    inputSchema: UpdateDraftInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        const raw = buildRfc2822Message({
          to: input.to,
          subject: input.subject,
          body: input.body,
          cc: input.cc,
          bcc: input.bcc,
          attachments: input.attachments as AttachmentSpec[] | undefined,
        });
        const res = await gmail.users.drafts.update({
          userId: 'me',
          id: input.draft_id,
          requestBody: { message: { raw } },
        });
        return {
          draftId: res.data.id ?? input.draft_id,
          messageId: res.data.message?.id ?? '',
        };
      } catch (err) {
        throw mapGmailError(err);
      }
    },
  };
}

// ── gmail_send_draft ──────────────────────────────────────────────────────────

const SendDraftInput = z.object({
  draft_id: z.string().describe('Draft ID to send (from gmail_list_drafts or gmail_create_draft).'),
});

export type SendDraftOutput = {
  messageId: string;
  threadId: string;
};

export function createSendDraftTool(
  gmail: gmail_v1.Gmail,
): ToolDefinition<typeof SendDraftInput, SendDraftOutput> {
  return {
    name: 'gmail_send_draft',
    description:
      'Send an existing Gmail draft. The draft is dispatched as an email and can no longer be edited.',
    inputSchema: SendDraftInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        const res = await gmail.users.drafts.send({
          userId: 'me',
          requestBody: { id: input.draft_id },
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

// ── gmail_delete_draft ────────────────────────────────────────────────────────

const DeleteDraftInput = z.object({
  draft_id: z.string().describe('Draft ID to permanently delete.'),
});

export type DeleteDraftOutput = {
  deleted: boolean;
  draftId: string;
};

export function createDeleteDraftTool(
  gmail: gmail_v1.Gmail,
): ToolDefinition<typeof DeleteDraftInput, DeleteDraftOutput> {
  return {
    name: 'gmail_delete_draft',
    description: 'Permanently delete a Gmail draft. This is irreversible.',
    inputSchema: DeleteDraftInput,
    riskLevel: 'destructive',
    async execute(input) {
      try {
        await gmail.users.drafts.delete({
          userId: 'me',
          id: input.draft_id,
        });
        return { deleted: true, draftId: input.draft_id };
      } catch (err) {
        throw mapGmailError(err);
      }
    },
  };
}
