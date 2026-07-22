// @nodal-agents/adapter-outlook-mail — folder tools
// list (Outlook's equivalent of Gmail labels for scoping/moving messages)

import { z } from 'zod';
import type { ToolDefinition } from '@nodal-agents/tools';
import type { Client } from '@microsoft/microsoft-graph-client';
import type { MailFolder } from '@microsoft/microsoft-graph-types';
import { mapOutlookError } from '../errors';
import { paginateOutlook } from '../helpers/pagination';
import type { ODataListResponse } from '../helpers/pagination';

// ── outlook_list_folders ────────────────────────────────────────────────────

const ListFoldersInput = z.object({
  max_results: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe('Max folders to return (default 50).'),
});

export type ListFoldersOutput = {
  total: number;
  folders: Array<{
    id: string;
    displayName: string;
    parentFolderId: string;
    unreadItemCount: number;
    totalItemCount: number;
  }>;
};

export function createListFoldersTool(
  client: Client,
): ToolDefinition<typeof ListFoldersInput, ListFoldersOutput> {
  return {
    name: 'outlook_list_folders',
    description:
      'List all Outlook mail folders (Inbox, Sent Items, Drafts, user-created folders, etc). ' +
      'Returns folder IDs needed for outlook_move_message and outlook_list_messages.',
    inputSchema: ListFoldersInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const maxResults = Math.min(input.max_results ?? 50, 500);
        const items = await paginateOutlook<MailFolder>(
          client,
          async () =>
            (await client
              .api('/me/mailFolders')
              .top(Math.min(maxResults, 100))
              .get()) as ODataListResponse<MailFolder>,
          maxResults,
        );
        return {
          total: items.length,
          folders: items.map((f) => ({
            id: f.id ?? '',
            displayName: f.displayName ?? '',
            parentFolderId: f.parentFolderId ?? '',
            unreadItemCount: f.unreadItemCount ?? 0,
            totalItemCount: f.totalItemCount ?? 0,
          })),
        };
      } catch (err) {
        throw mapOutlookError(err);
      }
    },
  };
}
