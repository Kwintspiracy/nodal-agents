// @nodal-agents/adapter-notion — comment tools

import { z } from 'zod';
import type { ToolDefinition } from '@nodal-agents/tools';
import type { Client } from '@notionhq/client';
import { mapNotionError } from '../errors';
import { chunkRichText } from '../helpers/property-coerce';

// ── notion_list_comments ──────────────────────────────────────────────────────

const ListCommentsInput = z.object({
  block_id: z.string().describe('Page or block ID to list comments for.'),
  page_size: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(50)
    .describe('Max comments to return (default 50).'),
});

export type CommentEntry = {
  id: string;
  author_id: string;
  author_name: string;
  text: string;
  created_time: string;
};

export type ListCommentsOutput = {
  total: number;
  comments: CommentEntry[];
};

export function createListCommentsTool(
  client: Client,
): ToolDefinition<typeof ListCommentsInput, ListCommentsOutput> {
  return {
    name: 'notion_list_comments',
    description: 'List comments on a Notion page or block.',
    inputSchema: ListCommentsInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const res = await client.comments.list({
          block_id: input.block_id,
          page_size: input.page_size,
        });

        const comments: CommentEntry[] = res.results.map((c) => {
          const richText = c.rich_text as Array<{ plain_text: string }>;
          const text = richText.map((p) => p.plain_text).join('');
          const author = c.created_by as { id: string; name?: string } | undefined;
          return {
            id: c.id,
            author_id: author?.id ?? '',
            author_name: author?.name ?? '',
            text: text.slice(0, 500),
            created_time: c.created_time,
          };
        });

        return { total: comments.length, comments };
      } catch (err) {
        throw mapNotionError(err);
      }
    },
  };
}

// ── notion_add_comment ────────────────────────────────────────────────────────

const AddCommentInput = z.object({
  page_id: z.string().describe('Page ID to comment on.'),
  text: z.string().describe('Comment text.'),
});

export type AddCommentOutput = {
  id: string;
  page_id: string;
};

export function createAddCommentTool(
  client: Client,
): ToolDefinition<typeof AddCommentInput, AddCommentOutput> {
  return {
    name: 'notion_add_comment',
    description: 'Add a comment to a Notion page.',
    inputSchema: AddCommentInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        const comment = await client.comments.create({
          parent: { page_id: input.page_id },
          rich_text: chunkRichText(input.text) as Parameters<
            typeof client.comments.create
          >[0]['rich_text'],
        });
        return { id: comment.id, page_id: input.page_id };
      } catch (err) {
        throw mapNotionError(err);
      }
    },
  };
}
