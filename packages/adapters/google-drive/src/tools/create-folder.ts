// @nodalai/adapter-google-drive — drive_create_folder tool

import { z } from 'zod';
import type { ToolDefinition } from '@nodalai/tools';
import type { drive_v3 } from 'googleapis';
import { mapDriveError } from '../errors';

const CreateFolderInput = z.object({
  name: z.string().describe('Folder name.'),
  parent_id: z
    .string()
    .optional()
    .describe('Optional parent folder ID. Creates in root if omitted.'),
});

export type CreateFolderOutput = {
  id: string;
  name: string;
  webViewLink: string;
};

export function createCreateFolderTool(
  drive: drive_v3.Drive,
): ToolDefinition<typeof CreateFolderInput, CreateFolderOutput> {
  return {
    name: 'drive_create_folder',
    description: 'Create a new folder in Google Drive.',
    inputSchema: CreateFolderInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        const resource: drive_v3.Schema$File = {
          name: input.name,
          mimeType: 'application/vnd.google-apps.folder',
          ...(input.parent_id && { parents: [input.parent_id] }),
        };

        const res = await drive.files.create({
          requestBody: resource,
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
