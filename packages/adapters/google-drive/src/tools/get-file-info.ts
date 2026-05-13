// @nodal-agents/adapter-google-drive — drive_get_file_info tool

import { z } from 'zod';
import type { ToolDefinition } from '@nodal-agents/tools';
import type { drive_v3 } from 'googleapis';
import { mapDriveError } from '../errors';

const GetFileInfoInput = z.object({
  file_id: z.string().describe('Google Drive file ID.'),
});

export type GetFileInfoOutput = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  createdTime: string;
  modifiedTime: string;
  owners: string[];
  shared: boolean;
  webViewLink: string;
  parents: string[];
};

export function createGetFileInfoTool(
  drive: drive_v3.Drive,
): ToolDefinition<typeof GetFileInfoInput, GetFileInfoOutput> {
  return {
    name: 'drive_get_file_info',
    description:
      'Get detailed metadata for a file: size, owner, sharing status, dates, MIME type, parent folders.',
    inputSchema: GetFileInfoInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const res = await drive.files.get({
          fileId: input.file_id,
          fields:
            'id,name,mimeType,size,createdTime,modifiedTime,owners,shared,webViewLink,parents',
        });
        const f = res.data;

        const owners = (f.owners ?? []).map((o) => o.displayName ?? o.emailAddress ?? '');

        return {
          id: f.id ?? '',
          name: f.name ?? '',
          mimeType: f.mimeType ?? '',
          sizeBytes: f.size != null ? Number(f.size) : null,
          createdTime: f.createdTime ?? '',
          modifiedTime: f.modifiedTime ?? '',
          owners,
          shared: f.shared ?? false,
          webViewLink: f.webViewLink ?? '',
          parents: f.parents ?? [],
        };
      } catch (err) {
        throw mapDriveError(err);
      }
    },
  };
}
