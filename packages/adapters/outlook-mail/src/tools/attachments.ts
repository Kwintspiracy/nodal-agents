// @nodal-agents/adapter-outlook-mail — attachment tools
// get attachment data by message_id + attachment_id

import { z } from 'zod';
import type { ToolDefinition } from '@nodal-agents/tools';
import type { Client } from '@microsoft/microsoft-graph-client';
import type { FileAttachment } from '@microsoft/microsoft-graph-types';
import { mapOutlookError, OutlookAdapterError } from '../errors';

// 25 MB consistent with adapter-gmail's gmail_get_attachment cap.
const ATTACHMENT_SIZE_CAP_BYTES = 25 * 1024 * 1024;

const GetAttachmentInput = z.object({
  message_id: z.string().describe('Outlook message ID containing the attachment.'),
  attachment_id: z.string().describe('Attachment ID (from outlook_get_message attachments list).'),
});

export type GetAttachmentOutput = {
  attachmentId: string;
  messageId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  data: string; // base64 encoded content
};

export function createGetAttachmentTool(
  client: Client,
): ToolDefinition<typeof GetAttachmentInput, GetAttachmentOutput> {
  return {
    name: 'outlook_get_attachment',
    description:
      'Download an email attachment by message ID and attachment ID. Returns base64-encoded content. ' +
      'Get attachment IDs from outlook_get_message. Size cap: 25 MB. Only file attachments are supported ' +
      '(item attachments — a nested message or event — are not).',
    inputSchema: GetAttachmentInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const attachment = (await client
          .api(
            `/me/messages/${encodeURIComponent(input.message_id)}/attachments/${encodeURIComponent(
              input.attachment_id,
            )}`,
          )
          .get()) as FileAttachment & { '@odata.type'?: string };

        if (attachment['@odata.type'] !== '#microsoft.graph.fileAttachment') {
          throw new OutlookAdapterError(
            'outlook_attachment_unsupported_type',
            'This attachment is not a file attachment (it may be a nested message or event) and cannot be downloaded as bytes.',
          );
        }

        const sizeBytes = attachment.size ?? 0;
        if (sizeBytes > ATTACHMENT_SIZE_CAP_BYTES) {
          throw new OutlookAdapterError(
            'outlook_attachment_too_large',
            `Attachment exceeds the 25 MB limit (${Math.round(sizeBytes / 1024 / 1024)} MB).`,
          );
        }

        return {
          attachmentId: input.attachment_id,
          messageId: input.message_id,
          filename: attachment.name ?? '',
          mimeType: attachment.contentType ?? 'application/octet-stream',
          sizeBytes,
          data: attachment.contentBytes ?? '',
        };
      } catch (err) {
        throw mapOutlookError(err);
      }
    },
  };
}
