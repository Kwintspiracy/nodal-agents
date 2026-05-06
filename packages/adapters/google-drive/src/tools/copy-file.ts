// @nodalai/adapter-google-drive — drive_copy_file tool

import { z } from 'zod';
import type { ToolDefinition } from '@nodalai/tools';
import type { drive_v3 } from 'googleapis';
import { mapDriveError } from '../errors';

const CopyFileInput = z.object({
  file_id: z.string().describe('File ID to copy.'),
  new_name: z.string().optional().describe('Optional name for the copy.'),
  folder_id: z.string().optional().describe('Optional destination folder ID for the copy.'),
});

export type CopyFileOutput = {
  id: string;
  name: string;
  webViewLink: string;
};

export function createCopyFileTool(
  drive: drive_v3.Drive,
): ToolDefinition<typeof CopyFileInput, CopyFileOutput> {
  return {
    name: 'drive_copy_file',
    description: 'Create a copy of a file in Google Drive.',
    inputSchema: CopyFileInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        const body: drive_v3.Schema$File = {};
        if (input.new_name) body.name = input.new_name;
        if (input.folder_id) body.parents = [input.folder_id];

        const res = await drive.files.copy({
          fileId: input.file_id,
          requestBody: Object.keys(body).length > 0 ? body : undefined,
          fields: 'id,name,webViewLink',
        });

        return {
          id: res.data.id ?? '',
          name: res.data.name ?? '',
          webViewLink: res.data.webViewLink ?? '',
        };
      } catch (err) {
        throw mapDriveError(err);
      }
    },
  };
}
