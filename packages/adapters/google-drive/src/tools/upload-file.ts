// @nodalai/adapter-google-drive — drive_upload_file tool

import { z } from 'zod';
import type { ToolDefinition } from '@nodalai/tools';
import type { drive_v3 } from 'googleapis';
import { mapDriveError } from '../errors.js';

const UploadFileInput = z.object({
  name: z.string().describe("File name including extension, e.g. 'cover_letter.txt'."),
  content: z.string().describe('Text content of the file.'),
  folder_id: z.string().optional().describe('Optional Drive folder ID to place the file in.'),
  mime_type: z.string().optional().describe("MIME type of the file. Default: 'text/plain'."),
});

export type UploadFileOutput = {
  id: string;
  name: string;
  webViewLink: string;
};

export function createUploadFileTool(
  drive: drive_v3.Drive,
): ToolDefinition<typeof UploadFileInput, UploadFileOutput> {
  return {
    name: 'drive_upload_file',
    description: 'Create a new file in Google Drive with text content.',
    inputSchema: UploadFileInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        const mimeType = input.mime_type ?? 'text/plain';
        const resource: drive_v3.Schema$File = {
          name: input.name,
          mimeType,
          ...(input.folder_id && { parents: [input.folder_id] }),
        };

        const { Readable } = await import('stream');
        const media = {
          mimeType,
          body: Readable.from([Buffer.from(input.content, 'utf-8')]),
        };

        const res = await drive.files.create({
          requestBody: resource,
          media,
          fields: 'id,name,webViewLink',
        });

        return {
          id: res.data.id ?? '',
          name: res.data.name ?? input.name,
          webViewLink: res.data.webViewLink ?? '',
        };
      } catch (err) {
        throw mapDriveError(err);
      }
    },
  };
}
