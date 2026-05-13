// @nodal-agents/adapter-notion — comment tools tests

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client } from '@notionhq/client';
import { APIResponseError, APIErrorCode } from '@notionhq/client';
import { createListCommentsTool, createAddCommentTool } from '../../tools/comments';

function makeClient(): Client {
  return {
    comments: {
      list: vi.fn(),
      create: vi.fn(),
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

const fakeComment = {
  id: 'comment-1',
  object: 'comment',
  parent: { type: 'page_id', page_id: 'page-1' },
  discussion_id: 'disc-1',
  created_time: '2024-01-01T12:00:00.000Z',
  last_edited_time: '2024-01-01T12:00:00.000Z',
  created_by: { id: 'user-1', object: 'user', name: 'Alice' },
  rich_text: [
    {
      plain_text: 'Nice work!',
      annotations: {},
      href: null,
      type: 'text',
      text: { content: 'Nice work!', link: null },
    },
  ],
};

// ── notion_list_comments ──────────────────────────────────────────────────────

describe('notion_list_comments', () => {
  let client: Client;

  beforeEach(() => {
    client = makeClient();
  });

  it('returns list of comments with author and text', async () => {
    (client.comments.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      results: [fakeComment],
      has_more: false,
      next_cursor: null,
    });

    const tool = createListCommentsTool(client);
    const result = await tool.execute({ block_id: 'page-1', page_size: 50 }, {} as never);

    expect(result.total).toBe(1);
    expect(result.comments[0]).toMatchObject({
      id: 'comment-1',
      author_name: 'Alice',
      text: 'Nice work!',
      created_time: '2024-01-01T12:00:00.000Z',
    });
  });

  it('returns empty list when no comments', async () => {
    (client.comments.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    });

    const tool = createListCommentsTool(client);
    const result = await tool.execute({ block_id: 'page-1', page_size: 50 }, {} as never);

    expect(result.total).toBe(0);
  });

  it('maps 401 to notion_unauthorized', async () => {
    (client.comments.list as ReturnType<typeof vi.fn>).mockRejectedValueOnce(makeApiError(401));

    const tool = createListCommentsTool(client);
    await expect(tool.execute({ block_id: 'x', page_size: 50 }, {} as never)).rejects.toMatchObject(
      {
        code: 'notion_unauthorized',
      },
    );
  });

  it('has riskLevel read', () => {
    expect(createListCommentsTool(client).riskLevel).toBe('read');
  });
});

// ── notion_add_comment ────────────────────────────────────────────────────────

describe('notion_add_comment', () => {
  let client: Client;

  beforeEach(() => {
    client = makeClient();
  });

  it('creates a comment and returns id', async () => {
    (client.comments.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'comment-new',
      object: 'comment',
    });

    const tool = createAddCommentTool(client);
    const result = await tool.execute({ page_id: 'page-1', text: 'Great work!' }, {} as never);

    expect(result.id).toBe('comment-new');
    expect(result.page_id).toBe('page-1');
    expect(client.comments.create).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: { page_id: 'page-1' },
      }),
    );
  });

  it('maps 404 to notion_not_found', async () => {
    (client.comments.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(makeApiError(404));

    const tool = createAddCommentTool(client);
    await expect(tool.execute({ page_id: 'x', text: 'hello' }, {} as never)).rejects.toMatchObject({
      code: 'notion_not_found',
    });
  });

  it('has riskLevel write', () => {
    expect(createAddCommentTool(client).riskLevel).toBe('write');
  });
});
