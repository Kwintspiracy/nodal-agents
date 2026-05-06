// @nodalai/adapter-google-drive — drive_share_file tool

import { z } from 'zod';
import type { ToolDefinition } from '@nodalai/tools';
import type { drive_v3 } from 'googleapis';
import { mapDriveError } from '../errors';

const ShareFileInput = z.object({
  file_id: z.string().describe('File ID to share.'),
  email: z
    .string()
    .optional()
    .describe('Email address to share with. Omit for link sharing (anyone with link).'),
  role: z
    .enum(['reader', 'writer', 'commenter', 'owner'])
    .optional()
    .describe("Permission role: 'reader', 'writer', 'commenter', or 'owner'. Default: 'reader'."),
  type: z
    .enum(['user', 'group', 'domain', 'anyone'])
    .optional()
    .describe(
      "Permission type: 'user', 'group', 'domain', or 'anyone'. Defaults to 'user' if email provided, 'anyone' otherwise.",
    ),
});

export type ShareFileOutput = {
  permission_id: string;
  role: string;
  type: string;
  email: string | null;
};

export function createShareFileTool(
  drive: drive_v3.Drive,
): ToolDefinition<typeof ShareFileInput, ShareFileOutput> {
  return {
    name: 'drive_share_file',
    description:
      'Share a file with a user or make it accessible via link. Provide email for user sharing, or omit for anyone-with-link sharing.',
    inputSchema: ShareFileInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        const role = input.role ?? 'reader';
        const permType = input.type ?? (input.email ? 'user' : 'anyone');

        const permission: drive_v3.Schema$Permission = {
          role,
          type: permType,
          ...(input.email && { emailAddress: input.email }),
        };

        const res = await drive.permissions.create({
          fileId: input.file_id,
          requestBody: permission,
          fields: 'id,role,type,emailAddress',
          // Suppress notification email unless explicitly sharing with a user
          sendNotificationEmail: permType === 'user' || permType === 'group',
        });

        return {
          permission_id: res.data.id ?? '',
          role: res.data.role ?? role,
          type: res.data.type ?? permType,
          email: res.data.emailAddress ?? null,
        };
      } catch (err) {
        throw mapDriveError(err);
      }
    },
  };
}
