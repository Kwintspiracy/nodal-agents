// @nodal-agents/adapter-gmail — thread tool tests

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { gmail_v1 } from 'googleapis';
import {
  createListThreadsTool,
  createGetThreadTool,
  createModifyThreadLabelsTool,
  createTrashThreadTool,
} from '../../tools/threads';

function makeGmail(): gmail_v1.Gmail {
  return {
    users: {
      threads: {
        list: vi.fn(),
        get: vi.fn(),
        modify: vi.fn(),
        trash: vi.fn(),
      },
    },
  } as unknown as gmail_v1.Gmail;
}

describe('gmail_list_threads', () => {
  let gmail: gmail_v1.Gmail;
  beforeEach(() => {
    gmail = makeGmail();
  });

  it('returns list of threads', async () => {
    (gmail.users.threads.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        threads: [
          { id: 'thread-1', snippet: 'Hello there', historyId: '123' },
          { id: 'thread-2', snippet: 'Another thread', historyId: '124' },
        ],
        nextPageToken: null,
      },
    });

    const tool = createListThreadsTool(gmail);
    const result = await tool.execute({ max_results: 10 }, {} as never);

    expect(result.total).toBe(2);
    expect(result.threads[0]?.threadId).toBe('thread-1');
    expect(result.threads[0]?.snippet).toBe('Hello there');
  });

  it('passes query when provided', async () => {
    (gmail.users.threads.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { threads: [], nextPageToken: null },
    });

    const tool = createListThreadsTool(gmail);
    await tool.execute({ query: 'is:unread' }, {} as never);

    const callArgs = (gmail.users.threads.list as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      q?: string;
    };
    expect(callArgs?.q).toBe('is:unread');
  });

  it('maps 401 to gmail_unauthorized', async () => {
    (gmail.users.threads.list as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });

    const tool = createListThreadsTool(gmail);
    await expect(tool.execute({}, {} as never)).rejects.toMatchObject({
      code: 'gmail_unauthorized',
    });
  });

  it('has riskLevel read', () => {
    expect(createListThreadsTool(gmail).riskLevel).toBe('read');
  });
});

describe('gmail_get_thread', () => {
  let gmail: gmail_v1.Gmail;
  beforeEach(() => {
    gmail = makeGmail();
  });

  it('returns thread with messages', async () => {
    (gmail.users.threads.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        id: 'thread-1',
        messages: [
          {
            id: 'msg-1',
            threadId: 'thread-1',
            snippet: 'Test snippet',
            labelIds: ['INBOX'],
            payload: {
              headers: [
                { name: 'From', value: 'alice@example.com' },
                { name: 'To', value: 'bob@example.com' },
                { name: 'Subject', value: 'Hello' },
                { name: 'Date', value: '2024-01-01' },
              ],
              mimeType: 'text/plain',
              body: { data: '' },
            },
          },
        ],
      },
    });

    const tool = createGetThreadTool(gmail);
    const result = await tool.execute({ thread_id: 'thread-1' }, {} as never);

    expect(result.threadId).toBe('thread-1');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.messageId).toBe('msg-1');
    expect(result.messages[0]?.from).toBe('alice@example.com');
    expect(result.messages[0]?.subject).toBe('Hello');
  });

  it('maps 404 to gmail_message_not_found', async () => {
    (gmail.users.threads.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 404,
      message: 'Not Found',
    });

    const tool = createGetThreadTool(gmail);
    await expect(tool.execute({ thread_id: 'missing' }, {} as never)).rejects.toMatchObject({
      code: 'gmail_message_not_found',
    });
  });

  it('has riskLevel read', () => {
    expect(createGetThreadTool(gmail).riskLevel).toBe('read');
  });
});

describe('gmail_modify_thread_labels', () => {
  let gmail: gmail_v1.Gmail;
  beforeEach(() => {
    gmail = makeGmail();
  });

  it('modifies labels on a thread', async () => {
    (gmail.users.threads.modify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { id: 'thread-1' },
    });

    const tool = createModifyThreadLabelsTool(gmail);
    const result = await tool.execute(
      { thread_id: 'thread-1', add_labels: ['STARRED'], remove_labels: ['UNREAD'] },
      {} as never,
    );

    expect(result.threadId).toBe('thread-1');
  });

  it('has riskLevel write', () => {
    expect(createModifyThreadLabelsTool(gmail).riskLevel).toBe('write');
  });
});

describe('gmail_trash_thread', () => {
  let gmail: gmail_v1.Gmail;
  beforeEach(() => {
    gmail = makeGmail();
  });

  it('moves a thread to trash', async () => {
    (gmail.users.threads.trash as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { id: 'thread-1' },
    });

    const tool = createTrashThreadTool(gmail);
    const result = await tool.execute({ thread_id: 'thread-1' }, {} as never);

    expect(result.threadId).toBe('thread-1');
  });

  it('maps 404 to gmail_message_not_found', async () => {
    (gmail.users.threads.trash as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 404,
      message: 'Not Found',
    });

    const tool = createTrashThreadTool(gmail);
    await expect(tool.execute({ thread_id: 'missing' }, {} as never)).rejects.toMatchObject({
      code: 'gmail_message_not_found',
    });
  });

  it('has riskLevel write', () => {
    expect(createTrashThreadTool(gmail).riskLevel).toBe('write');
  });
});
