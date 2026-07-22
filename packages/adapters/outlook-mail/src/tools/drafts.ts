// @nodal-agents/adapter-outlook-mail — draft tools
// list, create, update, send, delete

import { z } from 'zod';
import type { ToolDefinition } from '@nodal-agents/tools';
import type { Client } from '@microsoft/microsoft-graph-client';
import type { Message } from '@microsoft/microsoft-graph-types';
import { mapOutlookError, OutlookAdapterError } from '../errors';
import { paginateOutlook } from '../helpers/pagination';
import type { ODataListResponse } from '../helpers/pagination';
import { parseRecipients, buildFileAttachments, detectBodyContentType } from '../helpers/message';
import type { AttachmentSpec } from '../helpers/message';

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

const DRAFT_SELECT = ['id', 'subject', 'toRecipients', 'bodyPreview'];

// ── outlook_list_drafts ───────────────────────────────────────────────────────

const ListDraftsInput = z.object({
  max_results: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe('Max drafts to return (default 20).'),
});

export type ListDraftsOutput = {
  total: number;
  drafts: Array<{ draftId: string; to: string; subject: string; bodyPreview: string }>;
};

export function createListDraftsTool(
  client: Client,
): ToolDefinition<typeof ListDraftsInput, ListDraftsOutput> {
  return {
    name: 'outlook_list_drafts',
    description:
      'List Outlook drafts with their IDs, recipients, subjects and previews. ' +
      'Use draft_id with outlook_send_draft to send or outlook_update_draft to edit.',
    inputSchema: ListDraftsInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const maxResults = Math.min(input.max_results ?? 20, 500);
        const items = await paginateOutlook<Message>(
          client,
          async () =>
            (await client
              .api('/me/mailFolders/drafts/messages')
              .select(DRAFT_SELECT)
              .top(Math.min(maxResults, 100))
              .get()) as ODataListResponse<Message>,
          maxResults,
        );
        return {
          total: items.length,
          drafts: items.map((m) => ({
            draftId: m.id ?? '',
            to: (m.toRecipients ?? [])
              .map((r) => r.emailAddress?.address ?? '')
              .filter(Boolean)
              .join(', '),
            subject: m.subject ?? '',
            bodyPreview: m.bodyPreview ?? '',
          })),
        };
      } catch (err) {
        throw mapOutlookError(err);
      }
    },
  };
}

// ── outlook_create_draft ────────────────────────────────────────────────────

const CreateDraftInput = z.object({
  to: z.string().describe('Recipient email address.'),
  subject: z.string().describe('Email subject line.'),
  body: z.string().describe('Email body — plain text or HTML.'),
  cc: z.string().optional().describe('CC address(es), comma-separated.'),
  bcc: z.string().optional().describe('BCC address(es), comma-separated.'),
  attachments: z.array(AttachmentItemSchema).optional().describe('Optional file attachments.'),
});

export type CreateDraftOutput = { draftId: string; subject: string };

export function createCreateDraftTool(
  client: Client,
): ToolDefinition<typeof CreateDraftInput, CreateDraftOutput> {
  return {
    name: 'outlook_create_draft',
    description: 'Create a draft email in Outlook (not sent).',
    inputSchema: CreateDraftInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        const message: Message = {
          subject: input.subject,
          body: { contentType: detectBodyContentType(input.body), content: input.body },
          toRecipients: parseRecipients(input.to),
          ccRecipients: parseRecipients(input.cc),
          bccRecipients: parseRecipients(input.bcc),
          attachments: buildFileAttachments(input.attachments as AttachmentSpec[] | undefined),
        };
        const created = (await client.api('/me/messages').post(message)) as Message;
        return { draftId: created.id ?? '', subject: created.subject ?? '' };
      } catch (err) {
        throw mapOutlookError(err);
      }
    },
  };
}

// ── outlook_update_draft ────────────────────────────────────────────────────

const UpdateDraftInput = z.object({
  draft_id: z
    .string()
    .describe('Draft ID to update (from outlook_list_drafts or outlook_create_draft).'),
  to: z.string().optional().describe('Recipient email address.'),
  subject: z.string().optional().describe('Email subject line.'),
  body: z.string().optional().describe('Email body — plain text or HTML.'),
  cc: z.string().optional().describe('CC address(es), comma-separated.'),
  bcc: z.string().optional().describe('BCC address(es), comma-separated.'),
  attachments: z
    .array(AttachmentItemSchema)
    .optional()
    .describe(
      'Optional file attachments to ADD to the draft (Graph appends; it does not replace existing attachments).',
    ),
});

export type UpdateDraftOutput = { draftId: string };

export function createUpdateDraftTool(
  client: Client,
): ToolDefinition<typeof UpdateDraftInput, UpdateDraftOutput> {
  return {
    name: 'outlook_update_draft',
    description:
      'Update fields on an existing Outlook draft. Only the fields provided are changed. New attachments are ADDED ' +
      '— existing attachments are not removed or replaced.',
    inputSchema: UpdateDraftInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        // Review MINOR-3: an empty patch AND zero attachments is a no-op that
        // would otherwise silently report success without touching anything
        // — fail loud instead (invariant #4), same posture as
        // outlook_update_message's "provide at least one field" check.
        const hasFieldUpdate =
          input.subject !== undefined ||
          input.body !== undefined ||
          input.to !== undefined ||
          input.cc !== undefined ||
          input.bcc !== undefined;
        const hasAttachments = (input.attachments?.length ?? 0) > 0;
        if (!hasFieldUpdate && !hasAttachments) {
          throw new OutlookAdapterError(
            'outlook_validation_error',
            'Provide at least one field to update (to/subject/body/cc/bcc) or at least one attachment to add.',
          );
        }

        const patch: Partial<Message> = {};
        if (input.subject !== undefined) patch.subject = input.subject;
        if (input.body !== undefined) {
          patch.body = { contentType: detectBodyContentType(input.body), content: input.body };
        }
        if (input.to !== undefined) patch.toRecipients = parseRecipients(input.to);
        if (input.cc !== undefined) patch.ccRecipients = parseRecipients(input.cc);
        if (input.bcc !== undefined) patch.bccRecipients = parseRecipients(input.bcc);

        const draftPath = `/me/messages/${encodeURIComponent(input.draft_id)}`;
        if (Object.keys(patch).length > 0) {
          await client.api(draftPath).patch(patch);
        }

        const newAttachments = buildFileAttachments(
          input.attachments as AttachmentSpec[] | undefined,
        );
        for (const attachment of newAttachments) {
          await client.api(`${draftPath}/attachments`).post(attachment);
        }

        return { draftId: input.draft_id };
      } catch (err) {
        throw mapOutlookError(err);
      }
    },
  };
}

// ── outlook_send_draft ──────────────────────────────────────────────────────

const SendDraftInput = z.object({
  draft_id: z
    .string()
    .describe('Draft ID to send (from outlook_list_drafts or outlook_create_draft).'),
});

export type SendDraftOutput = { sent: boolean; draftId: string };

export function createSendDraftTool(
  client: Client,
): ToolDefinition<typeof SendDraftInput, SendDraftOutput> {
  return {
    name: 'outlook_send_draft',
    description:
      'Send an existing Outlook draft. The draft is dispatched as an email and can no longer be edited.',
    inputSchema: SendDraftInput,
    riskLevel: 'destructive',
    async execute(input) {
      try {
        await client.api(`/me/messages/${encodeURIComponent(input.draft_id)}/send`).post({});
        return { sent: true, draftId: input.draft_id };
      } catch (err) {
        throw mapOutlookError(err);
      }
    },
  };
}

// ── outlook_delete_draft ────────────────────────────────────────────────────

const DeleteDraftInput = z.object({
  draft_id: z.string().describe('Draft ID to permanently delete.'),
});

export type DeleteDraftOutput = { deleted: boolean; draftId: string };

export function createDeleteDraftTool(
  client: Client,
): ToolDefinition<typeof DeleteDraftInput, DeleteDraftOutput> {
  return {
    name: 'outlook_delete_draft',
    description: 'Permanently delete an Outlook draft.',
    inputSchema: DeleteDraftInput,
    riskLevel: 'destructive',
    async execute(input) {
      try {
        await client.api(`/me/messages/${encodeURIComponent(input.draft_id)}`).delete();
        return { deleted: true, draftId: input.draft_id };
      } catch (err) {
        throw mapOutlookError(err);
      }
    },
  };
}
