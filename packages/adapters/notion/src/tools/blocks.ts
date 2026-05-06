// @nodalai/adapter-notion — block tools

import { z } from 'zod';
import type { ToolDefinition } from '@nodalai/tools';
import type { Client } from '@notionhq/client';
import { mapNotionError } from '../errors';
import { chunkRichText } from '../helpers/property-coerce';
import { blockToText } from '../helpers/block-to-text';
import type { BlockObjectResponse } from '@notionhq/client/build/src/api-endpoints.js';

// ── notion_get_block ──────────────────────────────────────────────────────────

const GetBlockInput = z.object({
  block_id: z.string().describe('Block ID to retrieve.'),
});

export type GetBlockOutput = {
  id: string;
  type: string;
  text: string | null;
  has_children: boolean;
};

export function createGetBlockTool(
  client: Client,
): ToolDefinition<typeof GetBlockInput, GetBlockOutput> {
  return {
    name: 'notion_get_block',
    description:
      'Retrieve a specific Notion block by ID. Returns the block type and its text content.',
    inputSchema: GetBlockInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const block = await client.blocks.retrieve({ block_id: input.block_id });
        const typed = block as BlockObjectResponse;
        return {
          id: block.id,
          type: 'type' in block ? String(block.type) : 'unknown',
          text: blockToText(typed),
          has_children: 'has_children' in block ? Boolean(block.has_children) : false,
        };
      } catch (err) {
        throw mapNotionError(err);
      }
    },
  };
}

// ── notion_append_blocks ──────────────────────────────────────────────────────

const BlockItemSchema = z.object({
  type: z
    .enum([
      'paragraph',
      'heading_1',
      'heading_2',
      'heading_3',
      'bulleted_list_item',
      'numbered_list_item',
      'to_do',
      'code',
      'quote',
      'callout',
      'toggle',
      'divider',
    ])
    .describe('Block type.'),
  content: z
    .string()
    .optional()
    .default('')
    .describe('Text content for the block (not used for divider).'),
  language: z
    .string()
    .optional()
    .describe('Programming language for code blocks (e.g. "python", "javascript").'),
  checked: z.boolean().optional().default(false).describe('Whether a to_do block is checked.'),
});

const AppendBlocksInput = z.object({
  page_id: z.string().describe('Page or block ID to append content to.'),
  blocks: z
    .array(BlockItemSchema)
    .min(1)
    .max(100)
    .describe(
      'Array of blocks to add. Example: [{"type": "heading_2", "content": "Summary"}, {"type": "paragraph", "content": "The results show..."}]',
    ),
});

export type AppendBlocksOutput = {
  page_id: string;
  appended_count: number;
};

function buildBlock(item: z.infer<typeof BlockItemSchema>): Record<string, unknown> {
  if (item.type === 'divider') {
    return { object: 'block', type: 'divider', divider: {} };
  }

  const richText = chunkRichText(item.content ?? '');

  if (item.type === 'code') {
    return {
      object: 'block',
      type: 'code',
      code: { rich_text: richText, language: item.language ?? 'plain text' },
    };
  }

  if (item.type === 'to_do') {
    return {
      object: 'block',
      type: 'to_do',
      to_do: { rich_text: richText, checked: item.checked ?? false },
    };
  }

  return {
    object: 'block',
    type: item.type,
    [item.type]: { rich_text: richText },
  };
}

export function createAppendBlocksTool(
  client: Client,
): ToolDefinition<typeof AppendBlocksInput, AppendBlocksOutput> {
  return {
    name: 'notion_append_blocks',
    description:
      'Add content blocks to an existing Notion page. Supports paragraphs, headings, lists, code blocks, quotes, and dividers.',
    inputSchema: AppendBlocksInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        const children = input.blocks.map(buildBlock);
        await client.blocks.children.append({
          block_id: input.page_id,
          children: children as Parameters<typeof client.blocks.children.append>[0]['children'],
        });
        return { page_id: input.page_id, appended_count: children.length };
      } catch (err) {
        throw mapNotionError(err);
      }
    },
  };
}

// ── notion_update_block ───────────────────────────────────────────────────────

const UpdateBlockInput = z.object({
  block_id: z.string().describe('Block ID to update.'),
  content: z.string().describe('New text content for the block.'),
});

export type UpdateBlockOutput = { id: string };

export function createUpdateBlockTool(
  client: Client,
): ToolDefinition<typeof UpdateBlockInput, UpdateBlockOutput> {
  return {
    name: 'notion_update_block',
    description:
      'Update the text content of an existing Notion block. The block type is preserved.',
    inputSchema: UpdateBlockInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        // Retrieve current type so we can update the right property
        const existing = await client.blocks.retrieve({ block_id: input.block_id });
        const btype = 'type' in existing ? String(existing.type) : 'paragraph';
        const richText = chunkRichText(input.content);

        const updatePayload: Record<string, unknown> = {
          block_id: input.block_id,
          [btype]: { rich_text: richText },
        };

        await client.blocks.update(updatePayload as Parameters<typeof client.blocks.update>[0]);
        return { id: input.block_id };
      } catch (err) {
        throw mapNotionError(err);
      }
    },
  };
}

// ── notion_delete_block ───────────────────────────────────────────────────────

const DeleteBlockInput = z.object({
  block_id: z.string().describe('Block ID to delete (archive).'),
});

export type DeleteBlockOutput = { id: string; deleted: true };

export function createDeleteBlockTool(
  client: Client,
): ToolDefinition<typeof DeleteBlockInput, DeleteBlockOutput> {
  return {
    name: 'notion_delete_block',
    description: 'Delete (archive) a specific block from a Notion page.',
    inputSchema: DeleteBlockInput,
    riskLevel: 'destructive',
    async execute(input) {
      try {
        await client.blocks.delete({ block_id: input.block_id });
        return { id: input.block_id, deleted: true };
      } catch (err) {
        throw mapNotionError(err);
      }
    },
  };
}
