// @nodal-agents/adapter-gmail — attachment tools
// get attachment data by message_id + attachment_id

import { z } from 'zod';
import type { ToolDefinition } from '@nodal-agents/tools';
import type { gmail_v1 } from 'googleapis';
import { mapGmailError, GmailAdapterError } from '../errors';

// 25 MB consistent with Drive adapter
const ATTACHMENT_SIZE_CAP_BYTES = 25 * 1024 * 1024;

const GetAttachmentInput = z.object({
  message_id: z.string().describe('Gmail message ID containing the attachment.'),
  attachment_id: z.string().describe('Attachment ID (from gmail_get_message attachments list).'),
  filename: z.string().optional().describe('Filename hint (for display only, not required).'),
});

export type GetAttachmentOutput = {
  attachmentId: string;
  messageId: string;
  filename: string;
  sizeBytes: number;
  data: string; // base64url encoded content
};

export function createGetAttachmentTool(
  gmail: gmail_v1.Gmail,
): ToolDefinition<typeof GetAttachmentInput, GetAttachmentOutput> {
  return {
    name: 'gmail_get_attachment',
    description:
      'Download an email attachment by message ID and attachment ID. ' +
      'Returns base64url-encoded content. Get attachment IDs from gmail_get_message. ' +
      'Size cap: 25 MB.',
    inputSchema: GetAttachmentInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const res = await gmail.users.messages.attachments.get({
          userId: 'me',
          messageId: input.message_id,
          id: input.attachment_id,
        });
        const attachment = res.data;
        const sizeBytes = attachment.size ?? 0;

        if (sizeBytes > ATTACHMENT_SIZE_CAP_BYTES) {
          throw new GmailAdapterError(
            'gmail_attachment_too_large',
            `Attachment exceeds the 25 MB limit (${Math.round(sizeBytes / 1024 / 1024)} MB).`,
          );
        }

        return {
          attachmentId: input.attachment_id,
          messageId: input.message_id,
          filename: input.filename ?? '',
          sizeBytes,
          data: attachment.data ?? '',
        };
      } catch (err) {
        throw mapGmailError(err);
      }
    },
  };
}
