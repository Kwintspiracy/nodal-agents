// @nodalai/adapter-gmail — message tool tests

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { gmail_v1 } from 'googleapis';
import {
  createSendEmailTool,
  createListMessagesTool,
  createGetMessageTool,
  createReplyMessageTool,
  createModifyLabelsTool,
  createTrashMessageTool,
  createUntrashMessageTool,
  createDeleteMessageTool,
  createForwardMessageTool,
} from '../../tools/messages.js';

function makeGmail(): gmail_v1.Gmail {
  return {
    users: {
      messages: {
        list: vi.fn(),
        get: vi.fn(),
        send: vi.fn(),
        modify: vi.fn(),
        trash: vi.fn(),
        untrash: vi.fn(),
        delete: vi.fn(),
        attachments: { get: vi.fn() },
      },
      threads: {
        list: vi.fn(),
        get: vi.fn(),
        modify: vi.fn(),
        trash: vi.fn(),
      },
      labels: {
        list: vi.fn(),
        get: vi.fn(),
        create: vi.fn(),
        patch: vi.fn(),
        delete: vi.fn(),
      },
      drafts: {
        list: vi.fn(),
        get: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        send: vi.fn(),
        delete: vi.fn(),
      },
      history: {
        list: vi.fn(),
      },
    },
  } as unknown as gmail_v1.Gmail;
}

// ── gmail_send_email ──────────────────────────────────────────────────────────

describe('gmail_send_email', () => {
  let gmail: gmail_v1.Gmail;
  beforeEach(() => {
    gmail = makeGmail();
  });

  it('sends an email and returns messageId and threadId', async () => {
    (gmail.users.messages.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { id: 'msg-1', threadId: 'thread-1' },
    });

    const tool = createSendEmailTool(gmail);
    const result = await tool.execute(
      { to: 'alice@example.com', subject: 'Hello', body: 'World' },
      {} as never,
    );
    expect(result.messageId).toBe('msg-1');
    expect(result.threadId).toBe('thread-1');
  });

  it('calls messages.send with raw field', async () => {
    (gmail.users.messages.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { id: 'msg-2', threadId: 't-2' },
    });

    const tool = createSendEmailTool(gmail);
    await tool.execute({ to: 'alice@example.com', subject: 'Test', body: 'Content' }, {} as never);

    const callArgs = (gmail.users.messages.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      requestBody: { raw: string };
    };
    expect(typeof callArgs?.requestBody?.raw).toBe('string');
    expect(callArgs?.requestBody?.raw?.length).toBeGreaterThan(0);
  });

  it('maps 401 to gmail_unauthorized', async () => {
    (gmail.users.messages.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });

    const tool = createSendEmailTool(gmail);
    await expect(
      tool.execute({ to: 'a@example.com', subject: 'X', body: 'Y' }, {} as never),
    ).rejects.toMatchObject({ code: 'gmail_unauthorized' });
  });

  it('maps 429 to gmail_quota_exceeded', async () => {
    (gmail.users.messages.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 429,
      message: 'Rate limit',
    });

    const tool = createSendEmailTool(gmail);
    await expect(
      tool.execute({ to: 'a@example.com', subject: 'X', body: 'Y' }, {} as never),
    ).rejects.toMatchObject({ code: 'gmail_quota_exceeded' });
  });

  it('has riskLevel write', () => {
    expect(createSendEmailTool(gmail).riskLevel).toBe('write');
  });
});

// ── gmail_list_messages ───────────────────────────────────────────────────────

describe('gmail_list_messages', () => {
  let gmail: gmail_v1.Gmail;
  beforeEach(() => {
    gmail = makeGmail();
  });

  it('returns messages with metadata', async () => {
    (gmail.users.messages.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        messages: [{ id: 'msg-1', threadId: 'thread-1' }],
        nextPageToken: null,
      },
    });
    (gmail.users.messages.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        id: 'msg-1',
        threadId: 'thread-1',
        snippet: 'Hello world snippet',
        labelIds: ['INBOX'],
        payload: {
          headers: [
            { name: 'From', value: 'alice@example.com' },
            { name: 'Subject', value: 'Hello' },
            { name: 'Date', value: '2024-01-01' },
          ],
        },
      },
    });

    const tool = createListMessagesTool(gmail);
    const result = await tool.execute({ max_results: 10 }, {} as never);

    expect(result.total).toBe(1);
    expect(result.messages[0]?.messageId).toBe('msg-1');
    expect(result.messages[0]?.from).toBe('alice@example.com');
    expect(result.messages[0]?.subject).toBe('Hello');
    expect(result.messages[0]?.snippet).toBe('Hello world snippet');
  });

  it('returns empty list when no messages found', async () => {
    (gmail.users.messages.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { messages: [], nextPageToken: null },
    });

    const tool = createListMessagesTool(gmail);
    const result = await tool.execute({}, {} as never);

    expect(result.total).toBe(0);
    expect(result.messages).toHaveLength(0);
  });

  it('passes query param when provided', async () => {
    (gmail.users.messages.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { messages: [], nextPageToken: null },
    });

    const tool = createListMessagesTool(gmail);
    await tool.execute({ query: 'is:unread' }, {} as never);

    const callArgs = (gmail.users.messages.list as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      q?: string;
    };
    expect(callArgs?.q).toBe('is:unread');
  });

  it('maps 401 to gmail_unauthorized', async () => {
    (gmail.users.messages.list as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });

    const tool = createListMessagesTool(gmail);
    await expect(tool.execute({}, {} as never)).rejects.toMatchObject({
      code: 'gmail_unauthorized',
    });
  });

  it('has riskLevel read', () => {
    expect(createListMessagesTool(gmail).riskLevel).toBe('read');
  });
});

// ── gmail_get_message ─────────────────────────────────────────────────────────

describe('gmail_get_message', () => {
  let gmail: gmail_v1.Gmail;
  beforeEach(() => {
    gmail = makeGmail();
  });

  it('returns full message with body and attachments', async () => {
    (gmail.users.messages.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        id: 'msg-1',
        threadId: 'thread-1',
        snippet: 'Test snippet',
        labelIds: ['INBOX', 'UNREAD'],
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: 'alice@example.com' },
            { name: 'To', value: 'bob@example.com' },
            { name: 'Subject', value: 'Test' },
            { name: 'Date', value: '2024-01-01' },
          ],
          body: {
            data: Buffer.from('Hello, this is the body!', 'utf-8')
              .toString('base64')
              .replace(/\+/g, '-')
              .replace(/\//g, '_')
              .replace(/=/g, ''),
          },
        },
      },
    });

    const tool = createGetMessageTool(gmail);
    const result = await tool.execute({ message_id: 'msg-1' }, {} as never);

    expect(result.messageId).toBe('msg-1');
    expect(result.from).toBe('alice@example.com');
    expect(result.body).toContain('Hello, this is the body!');
    expect(result.labelIds).toContain('INBOX');
    expect(result.attachments).toHaveLength(0);
  });

  it('maps 404 to gmail_message_not_found', async () => {
    (gmail.users.messages.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 404,
      message: 'Not Found',
    });

    const tool = createGetMessageTool(gmail);
    await expect(tool.execute({ message_id: 'missing' }, {} as never)).rejects.toMatchObject({
      code: 'gmail_message_not_found',
    });
  });

  it('has riskLevel read', () => {
    expect(createGetMessageTool(gmail).riskLevel).toBe('read');
  });
});

// ── gmail_modify_labels ───────────────────────────────────────────────────────

describe('gmail_modify_labels', () => {
  let gmail: gmail_v1.Gmail;
  beforeEach(() => {
    gmail = makeGmail();
  });

  it('modifies labels and returns updated labelIds', async () => {
    (gmail.users.messages.modify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { id: 'msg-1', labelIds: ['INBOX', 'STARRED'] },
    });

    const tool = createModifyLabelsTool(gmail);
    const result = await tool.execute(
      { message_id: 'msg-1', add_labels: ['STARRED'], remove_labels: ['UNREAD'] },
      {} as never,
    );

    expect(result.messageId).toBe('msg-1');
    expect(result.labelIds).toContain('STARRED');
  });

  it('throws validation error when no labels provided', async () => {
    const tool = createModifyLabelsTool(gmail);
    await expect(tool.execute({ message_id: 'msg-1' }, {} as never)).rejects.toMatchObject({
      code: 'gmail_validation_error',
    });
  });

  it('maps 401 to gmail_unauthorized', async () => {
    (gmail.users.messages.modify as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });

    const tool = createModifyLabelsTool(gmail);
    await expect(
      tool.execute({ message_id: 'msg-1', add_labels: ['STARRED'] }, {} as never),
    ).rejects.toMatchObject({ code: 'gmail_unauthorized' });
  });

  it('has riskLevel write', () => {
    expect(createModifyLabelsTool(gmail).riskLevel).toBe('write');
  });
});

// ── gmail_trash_message ───────────────────────────────────────────────────────

describe('gmail_trash_message', () => {
  let gmail: gmail_v1.Gmail;
  beforeEach(() => {
    gmail = makeGmail();
  });

  it('moves a message to trash', async () => {
    (gmail.users.messages.trash as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { id: 'msg-1', threadId: 'thread-1' },
    });

    const tool = createTrashMessageTool(gmail);
    const result = await tool.execute({ message_id: 'msg-1' }, {} as never);

    expect(result.messageId).toBe('msg-1');
  });

  it('maps 404 to gmail_message_not_found', async () => {
    (gmail.users.messages.trash as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 404,
      message: 'Not Found',
    });

    const tool = createTrashMessageTool(gmail);
    await expect(tool.execute({ message_id: 'missing' }, {} as never)).rejects.toMatchObject({
      code: 'gmail_message_not_found',
    });
  });

  it('has riskLevel write', () => {
    expect(createTrashMessageTool(gmail).riskLevel).toBe('write');
  });
});

// ── gmail_untrash_message ─────────────────────────────────────────────────────

describe('gmail_untrash_message', () => {
  let gmail: gmail_v1.Gmail;
  beforeEach(() => {
    gmail = makeGmail();
  });

  it('restores a message from trash', async () => {
    (gmail.users.messages.untrash as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { id: 'msg-1', threadId: 'thread-1' },
    });

    const tool = createUntrashMessageTool(gmail);
    const result = await tool.execute({ message_id: 'msg-1' }, {} as never);
    expect(result.messageId).toBe('msg-1');
  });

  it('has riskLevel write', () => {
    expect(createUntrashMessageTool(gmail).riskLevel).toBe('write');
  });
});

// ── gmail_delete_message ──────────────────────────────────────────────────────

describe('gmail_delete_message', () => {
  let gmail: gmail_v1.Gmail;
  beforeEach(() => {
    gmail = makeGmail();
  });

  it('permanently deletes a message', async () => {
    (gmail.users.messages.delete as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: {} });

    const tool = createDeleteMessageTool(gmail);
    const result = await tool.execute({ message_id: 'msg-1' }, {} as never);

    expect(result.deleted).toBe(true);
    expect(result.messageId).toBe('msg-1');
  });

  it('maps 404 to gmail_message_not_found', async () => {
    (gmail.users.messages.delete as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 404,
      message: 'Not Found',
    });

    const tool = createDeleteMessageTool(gmail);
    await expect(tool.execute({ message_id: 'missing' }, {} as never)).rejects.toMatchObject({
      code: 'gmail_message_not_found',
    });
  });

  it('has riskLevel destructive', () => {
    expect(createDeleteMessageTool(gmail).riskLevel).toBe('destructive');
  });
});

// ── gmail_reply_message ───────────────────────────────────────────────────────

describe('gmail_reply_message', () => {
  let gmail: gmail_v1.Gmail;
  beforeEach(() => {
    gmail = makeGmail();
  });

  it('fetches original metadata and sends reply in-thread', async () => {
    (gmail.users.messages.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        id: 'msg-1',
        threadId: 'thread-1',
        payload: {
          headers: [
            { name: 'From', value: 'alice@example.com' },
            { name: 'Subject', value: 'Original subject' },
            { name: 'Message-ID', value: '<orig@example.com>' },
            { name: 'References', value: '' },
          ],
        },
      },
    });
    (gmail.users.messages.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { id: 'msg-2', threadId: 'thread-1' },
    });

    const tool = createReplyMessageTool(gmail);
    const result = await tool.execute({ message_id: 'msg-1', body: 'My reply.' }, {} as never);

    expect(result.messageId).toBe('msg-2');
    expect(result.threadId).toBe('thread-1');

    // Verify threadId was set on send
    const sendCall = (gmail.users.messages.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      requestBody: { threadId?: string; raw: string };
    };
    expect(sendCall?.requestBody?.threadId).toBe('thread-1');
  });

  it('has riskLevel write', () => {
    expect(createReplyMessageTool(gmail).riskLevel).toBe('write');
  });
});

// ── gmail_forward_message ─────────────────────────────────────────────────────

describe('gmail_forward_message', () => {
  let gmail: gmail_v1.Gmail;
  beforeEach(() => {
    gmail = makeGmail();
  });

  it('prefixes Fwd: to subject and includes forwarded body', async () => {
    (gmail.users.messages.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        id: 'msg-1',
        threadId: 'thread-1',
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: 'sender@example.com' },
            { name: 'Subject', value: 'Original' },
            { name: 'Date', value: '2024-01-01' },
            { name: 'To', value: 'recipient@example.com' },
          ],
          body: {
            data: Buffer.from('Original email body', 'utf-8')
              .toString('base64')
              .replace(/\+/g, '-')
              .replace(/\//g, '_')
              .replace(/=/g, ''),
          },
        },
      },
    });
    (gmail.users.messages.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { id: 'msg-3', threadId: 'thread-3' },
    });

    const tool = createForwardMessageTool(gmail);
    const result = await tool.execute({ message_id: 'msg-1', to: 'fwd@example.com' }, {} as never);

    expect(result.messageId).toBe('msg-3');

    const sendCall = (gmail.users.messages.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      requestBody: { raw: string };
    };
    // Decode the outer base64url envelope to get the full RFC 2822 raw message
    const rawEncoded = sendCall?.requestBody?.raw ?? '';
    const padded = rawEncoded.replace(/-/g, '+').replace(/_/g, '/');
    const padLength = (4 - (padded.length % 4)) % 4;
    const withPad = padded + '='.repeat(padLength);
    const rawMsg = Buffer.from(withPad, 'base64').toString('utf-8');
    expect(rawMsg).toContain('Fwd: Original');
    // The body is base64-encoded within the RFC 2822 message — decode it
    const bodyBase64 = rawMsg.split('\r\n\r\n').slice(1).join('\r\n\r\n').trim();
    const bodyPadded = bodyBase64.replace(/-/g, '+').replace(/_/g, '/');
    const bodyPadLength = (4 - (bodyPadded.replace(/\s/g, '').length % 4)) % 4;
    const bodyWithPad = bodyPadded.replace(/\s/g, '') + '='.repeat(bodyPadLength);
    const bodyText = Buffer.from(bodyWithPad, 'base64').toString('utf-8');
    expect(bodyText).toContain('Original email body');
  });

  it('has riskLevel write', () => {
    expect(createForwardMessageTool(gmail).riskLevel).toBe('write');
  });
});
