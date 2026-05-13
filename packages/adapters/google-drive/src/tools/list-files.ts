// @nodal-agents/adapter-google-drive — drive_list_files tool

import { z } from 'zod';
import type { ToolDefinition } from '@nodal-agents/tools';
import type { drive_v3 } from 'googleapis';
import { mapDriveError } from '../errors';
import { paginateDrive } from '../helpers/pagination';

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
    .describe('Max files to return (1–1000, default 20).'),
  order_by: z
    .string()
    .optional()
    .describe(
      "Sort order. Examples: 'modifiedTime desc', 'name', 'createdTime'. Default: 'modifiedTime desc'.",
    ),
});

export type ListFilesOutput = {
  total: number;
  files: Array<{
    id: string;
    name: string;
    mimeType: string;
    modifiedTime: string;
    size: number | null;
  }>;
};

export function createListFilesTool(
  drive: drive_v3.Drive,
): ToolDefinition<typeof ListFilesInput, ListFilesOutput> {
  return {
    name: 'drive_list_files',
    description:
      'List files in Google Drive. Optionally filter by folder or search query. Returns file names and IDs needed for drive_read_file.',
    inputSchema: ListFilesInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const maxResults = Math.min(input.max_results ?? 20, 1000);

        const files = await paginateDrive<drive_v3.Schema$File>(
          async (pageToken, pageSize) => {
            const params: drive_v3.Params$Resource$Files$List = {
              pageSize,
              fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,size)',
              orderBy: input.order_by ?? 'modifiedTime desc',
              ...(pageToken && { pageToken }),
              ...(input.query && { q: input.query }),
            };
            const res = await drive.files.list(params);
            return {
              items: res.data.files ?? [],
              nextPageToken: res.data.nextPageToken,
            };
          },
          Math.min(maxResults, 100),
          maxResults,
        );

        return {
          total: files.length,
          files: files.map((f) => ({
            id: f.id ?? '',
            name: f.name ?? '',
            mimeType: f.mimeType ?? '',
            modifiedTime: f.modifiedTime ?? '',
            size: f.size != null ? Number(f.size) : null,
          })),
        };
      } catch (err) {
        throw mapDriveError(err);
      }
    },
  };
}
