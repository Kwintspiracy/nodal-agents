// @nodalai/adapter-google-drive — drive_delete_file tool

import { z } from 'zod';
import type { ToolDefinition } from '@nodalai/tools';
import type { drive_v3 } from 'googleapis';
import { mapDriveError } from '../errors';

const DeleteFileInput = z.object({
  file_id: z.string().describe('File ID to move to trash.'),
});

export type DeleteFileOutput = {
  id: string;
  name: string;
  trashed: boolean;
};

export function createDeleteFileTool(
  drive: drive_v3.Drive,
): ToolDefinition<typeof DeleteFileInput, DeleteFileOutput> {
  return {
    name: 'drive_delete_file',
    description:
      'Move a file to trash in Google Drive. This is reversible — the file can be restored from the Drive trash.',
    inputSchema: DeleteFileInput,
    riskLevel: 'destructive',
    async execute(input) {
      try {
        const res = await drive.files.update({
          fileId: input.file_id,
          requestBody: { trashed: true },
          fields: 'id,name,trashed',
        });

        return {
          id: res.data.id ?? '',
          name: res.data.name ?? '',
          trashed: res.data.trashed ?? true,
        };
      } catch (err) {
        throw mapDriveError(err);
      }
    },
  };
}
