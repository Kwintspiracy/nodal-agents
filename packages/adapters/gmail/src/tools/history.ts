// @nodal-agents/adapter-gmail — history tools
// gmail_list_history — incremental sync using historyId

import { z } from 'zod';
import type { ToolDefinition } from '@nodal-agents/tools';
import type { gmail_v1 } from 'googleapis';
import { mapGmailError } from '../errors';

const ListHistoryInput = z.object({
  start_history_id: z
    .string()
    .describe(
      'The historyId to start listing changes from. ' +
        'Get an initial historyId from gmail_list_messages or gmail_get_message (historyId field).',
    ),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe('Max history records to return (default 100).'),
  label_id: z.string().optional().describe('Filter history records by label ID.'),
});

export type ListHistoryOutput = {
  historyId: string;
  history: Array<{
    id: string;
    messages: Array<{ messageId: string; threadId: string }>;
    messagesAdded: Array<{ messageId: string; labelIds: string[] }>;
    messagesDeleted: Array<{ messageId: string }>;
    labelsAdded: Array<{ messageId: string; labelIds: string[] }>;
    labelsRemoved: Array<{ messageId: string; labelIds: string[] }>;
  }>;
};

export function createListHistoryTool(
  gmail: gmail_v1.Gmail,
): ToolDefinition<typeof ListHistoryInput, ListHistoryOutput> {
  return {
    name: 'gmail_list_history',
    description:
      'List Gmail mailbox changes since a given historyId. ' +
      'Useful for incremental sync — only fetch changes since last check. ' +
      'Returns the latest historyId to use in subsequent calls.',
    inputSchema: ListHistoryInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const params: gmail_v1.Params$Resource$Users$History$List = {
          userId: 'me',
          startHistoryId: input.start_history_id,
          maxResults: Math.min(input.max_results ?? 100, 500),
          historyTypes: ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'],
          ...(input.label_id && { labelId: input.label_id }),
        };

        const res = await gmail.users.history.list(params);
        const data = res.data;

        const history = (data.history ?? []).map((record) => ({
          id: record.id ?? '',
          messages: (record.messages ?? []).map((m) => ({
            messageId: m.id ?? '',
            threadId: m.threadId ?? '',
          })),
          messagesAdded: (record.messagesAdded ?? []).map((ma) => ({
            messageId: ma.message?.id ?? '',
            labelIds: ma.message?.labelIds ?? [],
          })),
          messagesDeleted: (record.messagesDeleted ?? []).map((md) => ({
            messageId: md.message?.id ?? '',
          })),
          labelsAdded: (record.labelsAdded ?? []).map((la) => ({
            messageId: la.message?.id ?? '',
            labelIds: la.labelIds ?? [],
          })),
          labelsRemoved: (record.labelsRemoved ?? []).map((lr) => ({
            messageId: lr.message?.id ?? '',
            labelIds: lr.labelIds ?? [],
          })),
        }));

        return {
          historyId: data.historyId ?? '',
          history,
        };
      } catch (err) {
        throw mapGmailError(err);
      }
    },
  };
}
