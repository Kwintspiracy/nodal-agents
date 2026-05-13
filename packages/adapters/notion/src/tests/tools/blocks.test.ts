// @nodal-agents/adapter-notion — block tools tests

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client } from '@notionhq/client';
import { APIResponseError, APIErrorCode } from '@notionhq/client';
import {
  createGetBlockTool,
  createAppendBlocksTool,
  createUpdateBlockTool,
  createDeleteBlockTool,
} from '../../tools/blocks';

function makeClient(): Client {
  return {
    blocks: {
      retrieve: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      children: {
        append: vi.fn(),
      },
    },
  } as unknown as Client;
}

function makeApiError(status: number) {
  return new APIResponseError({
    status,
    headers: {} as Headers,
    rawBodyText: 'error',
    code: APIErrorCode.InternalServerError,
    message: `Error ${status}`,
  });
}

const fakeParagraphBlock = {
  object: 'block',
  id: 'block-1',
  type: 'paragraph',
  has_children: false,
  paragraph: {
    rich_text: [
      {
        plain_text: 'Hello',
        annotations: {},
        href: null,
        type: 'text',
        text: { content: 'Hello', link: null },
      },
    ],
    color: 'default',
  },
};

// ── notion_get_block ──────────────────────────────────────────────────────────

describe('notion_get_block', () => {
  let client: Client;

  beforeEach(() => {
    client = makeClient();
  });

  it('returns block id, type, text, has_children', async () => {
    (client.blocks.retrieve as ReturnType<typeof vi.fn>).mockResolvedValueOnce(fakeParagraphBlock);

    const tool = createGetBlockTool(client);
    const result = await tool.execute({ block_id: 'block-1' }, {} as never);

    expect(result.id).toBe('block-1');
    expect(result.type).toBe('paragraph');
    expect(result.text).toBe('Hello');
    expect(result.has_children).toBe(false);
  });

  it('maps 404 to notion_not_found', async () => {
    (client.blocks.retrieve as ReturnType<typeof vi.fn>).mockRejectedValueOnce(makeApiError(404));

    const tool = createGetBlockTool(client);
    await expect(tool.execute({ block_id: 'x' }, {} as never)).rejects.toMatchObject({
      code: 'notion_not_found',
    });
  });

  it('has riskLevel read', () => {
    expect(createGetBlockTool(client).riskLevel).toBe('read');
  });
});

// ── notion_append_blocks ──────────────────────────────────────────────────────

describe('notion_append_blocks', () => {
  let client: Client;

  beforeEach(() => {
    client = makeClient();
  });

  it('appends blocks and returns count', async () => {
    (client.blocks.children.append as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      results: [],
      type: 'block',
    });

    const tool = createAppendBlocksTool(client);
    const result = await tool.execute(
      {
        page_id: 'page-1',
        blocks: [
          { type: 'paragraph', content: 'Hello', checked: false },
          { type: 'heading_2', content: 'Title', checked: false },
        ],
      },
      {} as never,
    );

    expect(result.page_id).toBe('page-1');
    expect(result.appended_count).toBe(2);
    expect(client.blocks.children.append).toHaveBeenCalledOnce();
  });

  it('appends a divider block (no content)', async () => {
    (client.blocks.children.append as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      results: [],
    });

    const tool = createAppendBlocksTool(client);
    await tool.execute(
      { page_id: 'page-1', blocks: [{ type: 'divider', content: '', checked: false }] },
      {} as never,
    );

    const callArg = (client.blocks.children.append as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as {
      children: Array<{ type: string; divider: unknown }>;
    };
    const firstChild = callArg.children[0];
    expect(firstChild).toMatchObject({ type: 'divider', divider: {} });
  });

  it('appends a code block with language', async () => {
    (client.blocks.children.append as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      results: [],
    });

    const tool = createAppendBlocksTool(client);
    await tool.execute(
      {
        page_id: 'page-1',
        blocks: [
          { type: 'code', content: 'console.log(1)', language: 'javascript', checked: false },
        ],
      },
      {} as never,
    );

    const callArg = (client.blocks.children.append as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as {
      children: Array<{ type: string; code: { language: string } }>;
    };
    const firstChild = callArg.children[0];
    expect(firstChild?.code?.language).toBe('javascript');
  });

  it('maps 401 to notion_unauthorized', async () => {
    (client.blocks.children.append as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      makeApiError(401),
    );

    const tool = createAppendBlocksTool(client);
    await expect(
      tool.execute(
        { page_id: 'x', blocks: [{ type: 'paragraph', content: 'x', checked: false }] },
        {} as never,
      ),
    ).rejects.toMatchObject({ code: 'notion_unauthorized' });
  });

  it('has riskLevel write', () => {
    expect(createAppendBlocksTool(client).riskLevel).toBe('write');
  });
});

// ── notion_update_block ───────────────────────────────────────────────────────

describe('notion_update_block', () => {
  let client: Client;

  beforeEach(() => {
    client = makeClient();
  });

  it('retrieves block type then updates content', async () => {
    (client.blocks.retrieve as ReturnType<typeof vi.fn>).mockResolvedValueOnce(fakeParagraphBlock);
    (client.blocks.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'block-1' });

    const tool = createUpdateBlockTool(client);
    const result = await tool.execute(
      { block_id: 'block-1', content: 'Updated text' },
      {} as never,
    );

    expect(result.id).toBe('block-1');
    expect(client.blocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ block_id: 'block-1' }),
    );
  });

  it('maps 404 to notion_not_found', async () => {
    (client.blocks.retrieve as ReturnType<typeof vi.fn>).mockRejectedValueOnce(makeApiError(404));

    const tool = createUpdateBlockTool(client);
    await expect(tool.execute({ block_id: 'x', content: 'y' }, {} as never)).rejects.toMatchObject({
      code: 'notion_not_found',
    });
  });

  it('has riskLevel write', () => {
    expect(createUpdateBlockTool(client).riskLevel).toBe('write');
  });
});

// ── notion_delete_block ───────────────────────────────────────────────────────

describe('notion_delete_block', () => {
  let client: Client;

  beforeEach(() => {
    client = makeClient();
  });

  it('calls blocks.delete and returns confirmation', async () => {
    (client.blocks.delete as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'block-1' });

    const tool = createDeleteBlockTool(client);
    const result = await tool.execute({ block_id: 'block-1' }, {} as never);

    expect(result.id).toBe('block-1');
    expect(result.deleted).toBe(true);
    expect(client.blocks.delete).toHaveBeenCalledWith({ block_id: 'block-1' });
  });

  it('maps 429 to notion_rate_limited', async () => {
    (client.blocks.delete as ReturnType<typeof vi.fn>).mockRejectedValueOnce(makeApiError(429));

    const tool = createDeleteBlockTool(client);
    await expect(tool.execute({ block_id: 'x' }, {} as never)).rejects.toMatchObject({
      code: 'notion_rate_limited',
    });
  });

  it('has riskLevel destructive', () => {
    expect(createDeleteBlockTool(client).riskLevel).toBe('destructive');
  });
});
