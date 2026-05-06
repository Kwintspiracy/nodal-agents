// @nodalai/adapter-gmail — thread tools
// list, get, modify-labels, trash

import { z } from 'zod';
import type { ToolDefinition } from '@nodalai/tools';
import type { gmail_v1 } from 'googleapis';
import { mapGmailError } from '../errors';
import { paginateGmail } from '../helpers/pagination';
import { extractTextFromPayload, parseGmailHeaders } from '../helpers/parse-payload';

const BODY_CHAR_CAP = 5000;

// ── gmail_list_threads ────────────────────────────────────────────────────────

const ListThreadsInput = z.object({
  query: z
    .string()
    .optional()
    .describe("Gmail search query. Examples: 'is:unread', 'from:alice@example.com label:work'."),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe('Max threads to return (1–500, default 20).'),
  include_spam_trash: z
    .boolean()
    .optional()
    .describe('Include threads from SPAM and TRASH (default false).'),
});

export type ListThreadsOutput = {
  total: number;
  threads: Array<{
    threadId: string;
    snippet: string;
    historyId: string;
  }>;
};

export function createListThreadsTool(
  gmail: gmail_v1.Gmail,
): ToolDefinition<typeof ListThreadsInput, ListThreadsOutput> {
  return {
    name: 'gmail_list_threads',
    description:
      'List Gmail conversation threads matching a query. Returns thread IDs and snippets. ' +
      'Use gmail_get_thread to read the full conversation.',
    inputSchema: ListThreadsInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const maxResults = Math.min(input.max_results ?? 20, 500);

        const threads = await paginateGmail<gmail_v1.Schema$Thread>(
          async (pageToken, pageSize) => {
            const params: gmail_v1.Params$Resource$Users$Threads$List = {
              userId: 'me',
              maxResults: pageSize,
              includeSpamTrash: input.include_spam_trash ?? false,
              ...(pageToken && { pageToken }),
              ...(input.query && { q: input.query }),
            };
            const res = await gmail.users.threads.list(params);
            return {
              items: res.data.threads ?? [],
              nextPageToken: res.data.nextPageToken,
            };
          },
          Math.min(maxResults, 100),
          maxResults,
        );

        return {
          total: threads.length,
          threads: threads.map((t) => ({
            threadId: t.id ?? '',
            snippet: t.snippet ?? '',
            historyId: t.historyId ?? '',
          })),
        };
      } catch (err) {
        throw mapGmailError(err);
      }
    },
  };
}

// ── gmail_get_thread ──────────────────────────────────────────────────────────

const GetThreadInput = z.object({
  thread_id: z
    .string()
    .describe('Gmail thread ID (from gmail_list_threads or gmail_list_messages).'),
});

export type GetThreadOutput = {
  threadId: string;
  messages: Array<{
    messageId: string;
    from: string;
    to: string;
    subject: string;
    date: string;
    snippet: string;
    body: string;
    labelIds: string[];
  }>;
};

export function createGetThreadTool(
  gmail: gmail_v1.Gmail,
): ToolDefinition<typeof GetThreadInput, GetThreadOutput> {
  return {
    name: 'gmail_get_thread',
    description:
      'Fetch a full Gmail conversation thread with all messages, decoded bodies and headers.',
    inputSchema: GetThreadInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const res = await gmail.users.threads.get({
          userId: 'me',
          id: input.thread_id,
          format: 'full',
        });
        const thread = res.data;
        const messages = (thread.messages ?? []).map((msg) => {
          const payload = msg.payload ?? undefined;
          const headers = parseGmailHeaders(payload);
          let body = extractTextFromPayload(payload).trim();
          if (body.length > BODY_CHAR_CAP) {
            body = body.slice(0, BODY_CHAR_CAP) + '\n\n[...truncated]';
          }
          return {
            messageId: msg.id ?? '',
            from: headers['from'] ?? '',
            to: headers['to'] ?? '',
            subject: headers['subject'] ?? '',
            date: headers['date'] ?? '',
            snippet: msg.snippet ?? '',
            body,
            labelIds: msg.labelIds ?? [],
          };
        });

        return { threadId: thread.id ?? '', messages };
      } catch (err) {
        throw mapGmailError(err);
      }
    },
  };
}

// ── gmail_modify_thread_labels ────────────────────────────────────────────────

const ModifyThreadLabelsInput = z.object({
  thread_id: z.string().describe('Gmail thread ID.'),
  add_labels: z
    .array(z.string())
    .optional()
    .describe("Label IDs or system labels to add to all messages in the thread, e.g. ['STARRED']."),
  remove_labels: z
    .array(z.string())
    .optional()
    .describe("Label IDs or system labels to remove from all messages, e.g. ['UNREAD']."),
});

export type ModifyThreadLabelsOutput = {
  threadId: string;
};

export function createModifyThreadLabelsTool(
  gmail: gmail_v1.Gmail,
): ToolDefinition<typeof ModifyThreadLabelsInput, ModifyThreadLabelsOutput> {
  return {
    name: 'gmail_modify_thread_labels',
    description:
      'Add or remove labels on all messages in a Gmail thread at once. ' +
      'Use to archive a thread (remove INBOX), mark all as read (remove UNREAD), etc.',
    inputSchema: ModifyThreadLabelsInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        const res = await gmail.users.threads.modify({
          userId: 'me',
          id: input.thread_id,
          requestBody: {
            addLabelIds: input.add_labels ?? [],
            removeLabelIds: input.remove_labels ?? [],
          },
        });
        return { threadId: res.data.id ?? '' };
      } catch (err) {
        throw mapGmailError(err);
      }
    },
  };
}

// ── gmail_trash_thread ────────────────────────────────────────────────────────

const TrashThreadInput = z.object({
  thread_id: z.string().describe('Gmail thread ID to move to Trash.'),
});

export type TrashThreadOutput = {
  threadId: string;
};

export function createTrashThreadTool(
  gmail: gmail_v1.Gmail,
): ToolDefinition<typeof TrashThreadInput, TrashThreadOutput> {
  return {
    name: 'gmail_trash_thread',
    description:
      'Move an entire Gmail conversation thread to the Trash folder. Recoverable for 30 days.',
    inputSchema: TrashThreadInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        const res = await gmail.users.threads.trash({
          userId: 'me',
          id: input.thread_id,
        });
        return { threadId: res.data.id ?? '' };
      } catch (err) {
        throw mapGmailError(err);
      }
    },
  };
}
