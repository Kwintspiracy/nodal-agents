// @nodal-agents/adapter-google-drive — drive_list_files tool
//
// One provider page per call, in the connector contract's list shape
// (@nodal-agents/shared connector-contract.ts): `next` is Drive's own
// `nextPageToken`, read on by passing it back as `cursor`.

import { z } from 'zod';
import type { ConnectorToolDefinition } from '@nodal-agents/tools';
import { LIST_CURSOR_DESCRIPTION, type ConnectorList } from '@nodal-agents/shared';
import type { drive_v3 } from 'googleapis';
import { mapDriveError } from '../errors';

const ListFilesInput = z.object({
  query: z
    .string()
    .optional()
    .describe(
      'Google Drive search query. Examples: \'name contains "resume"\' or \'"folder-id" in parents\' or \'mimeType="application/pdf"\'. Leave empty to list recent files.',
    ),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe('Files per page (1–1000, default 20).'),
  order_by: z
    .string()
    .optional()
    .describe(
      "Sort order. Examples: 'modifiedTime desc', 'name', 'createdTime'. Default: 'modifiedTime desc'.",
    ),
  cursor: z.string().optional().describe(LIST_CURSOR_DESCRIPTION),
});

export type DriveFileItem = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size: number | null;
};

export type ListFilesOutput = ConnectorList<DriveFileItem>;

export function createListFilesTool(
  drive: drive_v3.Drive,
): ConnectorToolDefinition<typeof ListFilesInput, ListFilesOutput> {
  return {
    name: 'drive_list_files',
    description:
      'List files in Google Drive, one page per call. Optionally filter by folder or search query. ' +
      'Returns `items` (file names and the IDs drive_read_file needs) and `next`: pass it back as ' +
      '`cursor` to read the next page (null when there is none).',
    inputSchema: ListFilesInput,
    async execute(input) {
      try {
        const params: drive_v3.Params$Resource$Files$List = {
          pageSize: input.max_results ?? 20,
          fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,size)',
          orderBy: input.order_by ?? 'modifiedTime desc',
          ...(input.cursor && { pageToken: input.cursor }),
          ...(input.query && { q: input.query }),
        };
        const res = await drive.files.list(params);
        return {
          items: (res.data.files ?? []).map((f) => ({
            id: f.id ?? '',
            name: f.name ?? '',
            mimeType: f.mimeType ?? '',
            modifiedTime: f.modifiedTime ?? '',
            size: f.size != null ? Number(f.size) : null,
          })),
          next: res.data.nextPageToken ?? null,
          truncated: null,
        };
      } catch (err) {
        throw mapDriveError(err);
      }
    },
  };
}
