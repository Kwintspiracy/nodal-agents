// @nodalai/adapter-google-drive — drive_move_file tool

import { z } from 'zod';
import type { ToolDefinition } from '@nodalai/tools';
import type { drive_v3 } from 'googleapis';
import { mapDriveError } from '../errors.js';

const MoveFileInput = z.object({
  file_id: z.string().describe('File ID to move.'),
  new_parent_id: z.string().describe('Destination folder ID.'),
});

export type MoveFileOutput = {
  id: string;
  name: string;
  parents: string[];
};

export function createMoveFileTool(
  drive: drive_v3.Drive,
): ToolDefinition<typeof MoveFileInput, MoveFileOutput> {
  return {
    name: 'drive_move_file',
    description: 'Move a file to a different folder in Google Drive.',
    inputSchema: MoveFileInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        // Fetch current parents first
        const metaRes = await drive.files.get({
          fileId: input.file_id,
          fields: 'id,name,parents',
        });
        const currentParents = (metaRes.data.parents ?? []).join(',');

        const res = await drive.files.update({
          fileId: input.file_id,
          addParents: input.new_parent_id,
          removeParents: currentParents || undefined,
          fields: 'id,name,parents',
        });

        return {
          id: res.data.id ?? '',
          name: res.data.name ?? '',
          parents: res.data.parents ?? [],
        };
      } catch (err) {
        throw mapDriveError(err);
      }
    },
  };
}
