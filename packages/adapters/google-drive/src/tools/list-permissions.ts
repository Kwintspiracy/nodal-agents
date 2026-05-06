// @nodalai/adapter-google-drive — drive_list_permissions tool

import { z } from 'zod';
import type { ToolDefinition } from '@nodalai/tools';
import type { drive_v3 } from 'googleapis';
import { mapDriveError } from '../errors';

const ListPermissionsInput = z.object({
  file_id: z.string().describe('File ID to list permissions for.'),
});

export type PermissionEntry = {
  id: string;
  role: string;
  type: string;
  email: string | null;
  displayName: string | null;
};

export type ListPermissionsOutput = {
  total: number;
  permissions: PermissionEntry[];
};

export function createListPermissionsTool(
  drive: drive_v3.Drive,
): ToolDefinition<typeof ListPermissionsInput, ListPermissionsOutput> {
  return {
    name: 'drive_list_permissions',
    description: 'List who has access to a file and their permission levels.',
    inputSchema: ListPermissionsInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const res = await drive.permissions.list({
          fileId: input.file_id,
          fields: 'permissions(id,role,type,emailAddress,displayName)',
        });

        const perms = (res.data.permissions ?? []).map((p) => ({
          id: p.id ?? '',
          role: p.role ?? '',
          type: p.type ?? '',
          email: p.emailAddress ?? null,
          displayName: p.displayName ?? null,
        }));

        return { total: perms.length, permissions: perms };
      } catch (err) {
        throw mapDriveError(err);
      }
    },
  };
}
