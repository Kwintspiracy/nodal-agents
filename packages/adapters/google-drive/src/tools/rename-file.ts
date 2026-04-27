// @nodalai/adapter-google-drive — drive_rename_file tool

import { z } from 'zod';
import type { ToolDefinition } from '@nodalai/tools';
import type { drive_v3 } from 'googleapis';
import { mapDriveError } from '../errors.js';

const RenameFileInput = z.object({
  file_id: z.string().describe('File ID to rename.'),
  new_name: z.string().describe('New file name (including extension).'),
});

export type RenameFileOutput = {
  id: string;
  name: string;
};

export function createRenameFileTool(
  drive: drive_v3.Drive,
): ToolDefinition<typeof RenameFileInput, RenameFileOutput> {
  return {
    name: 'drive_rename_file',
    description: 'Rename a file in Google Drive.',
    inputSchema: RenameFileInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        const res = await drive.files.update({
          fileId: input.file_id,
          requestBody: { name: input.new_name },
          fields: 'id,name',
        });

        return {
          id: res.data.id ?? '',
          name: res.data.name ?? input.new_name,
        };
      } catch (err) {
        throw mapDriveError(err);
      }
    },
  };
}
