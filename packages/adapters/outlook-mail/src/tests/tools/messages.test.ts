// @nodal-agents/adapter-outlook-mail — message tool tests

import { describe, it, expect } from 'vitest';
import { makeMockRequest, makeMockClient } from '../mock-client';
import {
  createListMessagesTool,
  createGetMessageTool,
  createSendEmailTool,
  createReplyMessageTool,
  createForwardMessageTool,
  createDeleteMessageTool,
  createUpdateMessageTool,
  createMoveMessageTool,
} from '../../tools/messages';

describe('outlook_list_messages', () => {
  it('lists messages from the mailbox-wide endpoint when no folder is given', async () => {
    const req = makeMockRequest();
    req.get.mockResolvedValueOnce({
      value: [
        {
          id: 'm-1',
          from: { emailAddress: { address: 'alice@example.com' } },
          subject: 'Hi',
          receivedDateTime: '2026-01-01T00:00:00Z',
          bodyPreview: 'preview',
          isRead: false,
          hasAttachments: false,
          parentFolderId: 'inbox-id',
        },
      ],
    });
    const { client, api } = makeMockClient({ '/me/messages': req });

    const tool = createListMessagesTool(client);
    const result = await tool.execute({}, {} as never);

    expect(api).toHaveBeenCalledWith('/me/messages');
    expect(result.total).toBe(1);
    expect(result.messages[0]?.messageId).toBe('m-1');
    expect(result.messages[0]?.from).toBe('alice@example.com');
    expect(result.messages[0]?.subject).toBe('Hi');
  });

  it('scopes to a folder path when folder is provided', async () => {
    const req = makeMockRequest();
    req.get.mockResolvedValueOnce({ value: [] });
    const { client, api } = makeMockClient({ '/me/mailFolders/inbox/messages': req });

    const tool = createListMessagesTool(client);
    const result = await tool.execute({ folder: 'inbox' }, {} as never);

    expect(api).toHaveBeenCalledWith('/me/mailFolders/inbox/messages');
    expect(result.total).toBe(0);
  });

  it('applies $search when query is provided', async () => {
    const req = makeMockRequest();
    req.get.mockResolvedValueOnce({ value: [] });
    const { client } = makeMockClient({ '/me/messages': req });

    const tool = createListMessagesTool(client);
    await tool.execute({ query: 'invoice' }, {} as never);

    expect(req.search).toHaveBeenCalledWith('"invoice"');
  });

  it('applies $filter when filter is provided', async () => {
    const req = makeMockRequest();
    req.get.mockResolvedValueOnce({ value: [] });
    const { client } = makeMockClient({ '/me/messages': req });

    const tool = createListMessagesTool(client);
    await tool.execute({ filter: 'isRead eq false' }, {} as never);

    expect(req.filter).toHaveBeenCalledWith('isRead eq false');
  });

  it('maps a 401 GraphError to outlook_unauthorized', async () => {
    const req = makeMockRequest();
    req.get.mockRejectedValueOnce({ statusCode: 401, message: 'InvalidAuthenticationToken' });
    const { client } = makeMockClient({ '/me/messages': req });

    const tool = createListMessagesTool(client);
    await expect(tool.execute({}, {} as never)).rejects.toMatchObject({
      code: 'outlook_unauthorized',
    });
  });

  it('has riskLevel read', () => {
    const { client } = makeMockClient();
    expect(createListMessagesTool(client).riskLevel).toBe('read');
  });
});

describe('outlook_get_message', () => {
  it('returns the full message body and attachment metadata (without content bytes)', async () => {
    const msgReq = makeMockRequest();
    msgReq.get.mockResolvedValueOnce({
      id: 'm-1',
      from: { emailAddress: { address: 'alice@example.com' } },
      toRecipients: [{ emailAddress: { address: 'bob@example.com' } }],
      ccRecipients: [],
      subject: 'Test',
      receivedDateTime: '2026-01-01T00:00:00Z',
      body: { contentType: 'html', content: '<p>Hello <b>there</b></p>' },
      isRead: true,
      parentFolderId: 'inbox-id',
      hasAttachments: true,
    });
    const attReq = makeMockRequest();
    attReq.get.mockResolvedValueOnce({
      value: [{ id: 'att-1', name: 'file.txt', contentType: 'text/plain', size: 12 }],
    });

    const { client } = makeMockClient({
      '/me/messages/m-1': msgReq,
      '/me/messages/m-1/attachments': attReq,
    });

    const tool = createGetMessageTool(client);
    const result = await tool.execute({ message_id: 'm-1' }, {} as never);

    expect(result.messageId).toBe('m-1');
    expect(result.from).toBe('alice@example.com');
    expect(result.to).toBe('bob@example.com');
    expect(result.body).toContain('Hello there');
    expect(result.attachments).toEqual([
      { attachmentId: 'att-1', filename: 'file.txt', mimeType: 'text/plain', size: 12 },
    ]);
  });

  it('skips the attachments call when hasAttachments is false', async () => {
    const msgReq = makeMockRequest();
    msgReq.get.mockResolvedValueOnce({
      id: 'm-1',
      subject: 'No attachments',
      hasAttachments: false,
      body: { contentType: 'text', content: 'plain body' },
    });
    const { client, api } = makeMockClient({ '/me/messages/m-1': msgReq });

    const tool = createGetMessageTool(client);
    const result = await tool.execute({ message_id: 'm-1' }, {} as never);

    expect(result.attachments).toEqual([]);
    expect(api).not.toHaveBeenCalledWith('/me/messages/m-1/attachments');
  });

  it('flags truncation instead of silently cutting a long body', async () => {
    const msgReq = makeMockRequest();
    msgReq.get.mockResolvedValueOnce({
      id: 'm-1',
      subject: 'Long',
      hasAttachments: false,
      body: { contentType: 'text', content: 'x'.repeat(20000) },
    });
    const { client } = makeMockClient({ '/me/messages/m-1': msgReq });

    const tool = createGetMessageTool(client);
    const result = await tool.execute({ message_id: 'm-1' }, {} as never);

    expect(result.truncated).toBe(true);
    expect(result.body).toContain('[...body truncated]');
  });

  it('maps a 404 GraphError to outlook_not_found', async () => {
    const req = makeMockRequest();
    req.get.mockRejectedValueOnce({ statusCode: 404, message: 'ErrorItemNotFound' });
    const { client } = makeMockClient({ '/me/messages/missing': req });

    const tool = createGetMessageTool(client);
    await expect(tool.execute({ message_id: 'missing' }, {} as never)).rejects.toMatchObject({
      code: 'outlook_not_found',
    });
  });

  it('has riskLevel read', () => {
    const { client } = makeMockClient();
    expect(createGetMessageTool(client).riskLevel).toBe('read');
  });
});

describe('outlook_send_email', () => {
  it('posts a well-formed message to /me/sendMail and reports sent', async () => {
    const req = makeMockRequest();
    req.post.mockResolvedValueOnce(undefined);
    const { client } = makeMockClient({ '/me/sendMail': req });

    const tool = createSendEmailTool(client);
    const result = await tool.execute(
      { to: 'alice@example.com', subject: 'Hi', body: 'Hello' },
      {} as never,
    );

    expect(result.sent).toBe(true);
    const [body] = req.post.mock.calls[0] as [
      { message: { subject: string; toRecipients: unknown[] }; saveToSentItems: boolean },
    ];
    expect(body.message.subject).toBe('Hi');
    expect(body.message.toRecipients).toEqual([{ emailAddress: { address: 'alice@example.com' } }]);
    expect(body.saveToSentItems).toBe(true);
  });

  it('respects save_to_sent_items=false', async () => {
    const req = makeMockRequest();
    req.post.mockResolvedValueOnce(undefined);
    const { client } = makeMockClient({ '/me/sendMail': req });

    const tool = createSendEmailTool(client);
    await tool.execute(
      { to: 'a@example.com', subject: 'X', body: 'Y', save_to_sent_items: false },
      {} as never,
    );

    const [body] = req.post.mock.calls[0] as [{ saveToSentItems: boolean }];
    expect(body.saveToSentItems).toBe(false);
  });

  it('includes base64-encoded attachments in the outgoing payload', async () => {
    const req = makeMockRequest();
    req.post.mockResolvedValueOnce(undefined);
    const { client } = makeMockClient({ '/me/sendMail': req });

    const tool = createSendEmailTool(client);
    await tool.execute(
      {
        to: 'a@example.com',
        subject: 'X',
        body: 'Y',
        attachments: [{ filename: 'a.txt', content: 'hello' }],
      },
      {} as never,
    );

    const [body] = req.post.mock.calls[0] as [
      { message: { attachments: Array<{ name: string; contentBytes: string }> } },
    ];
    expect(body.message.attachments[0]?.name).toBe('a.txt');
    expect(body.message.attachments[0]?.contentBytes).toBe(
      Buffer.from('hello', 'utf-8').toString('base64'),
    );
  });

  it('maps a 429 GraphError to outlook_quota_exceeded with retryAfterSeconds', async () => {
    const req = makeMockRequest();
    req.post.mockRejectedValueOnce({
      statusCode: 429,
      message: 'TooManyRequests',
      headers: new Headers({ 'Retry-After': '30' }),
    });
    const { client } = makeMockClient({ '/me/sendMail': req });

    const tool = createSendEmailTool(client);
    await expect(
      tool.execute({ to: 'a@example.com', subject: 'X', body: 'Y' }, {} as never),
    ).rejects.toMatchObject({
      code: 'outlook_quota_exceeded',
      retryAfterSeconds: 30,
    });
  });

  it('has riskLevel destructive', () => {
    const { client } = makeMockClient();
    expect(createSendEmailTool(client).riskLevel).toBe('destructive');
  });
});

describe('outlook_reply_message', () => {
  it('posts to /reply by default', async () => {
    const req = makeMockRequest();
    req.post.mockResolvedValueOnce(undefined);
    const { client } = makeMockClient({ '/me/messages/m-1/reply': req });

    const tool = createReplyMessageTool(client);
    const result = await tool.execute({ message_id: 'm-1', comment: 'Thanks!' }, {} as never);

    expect(result).toEqual({ sent: true, replyAll: false });
    expect(req.post).toHaveBeenCalledWith({ comment: 'Thanks!' });
  });

  it('posts to /replyAll when reply_all is true', async () => {
    const req = makeMockRequest();
    req.post.mockResolvedValueOnce(undefined);
    const { client, api } = makeMockClient({ '/me/messages/m-1/replyAll': req });

    const tool = createReplyMessageTool(client);
    const result = await tool.execute(
      { message_id: 'm-1', comment: 'Thanks all!', reply_all: true },
      {} as never,
    );

    expect(api).toHaveBeenCalledWith('/me/messages/m-1/replyAll');
    expect(result.replyAll).toBe(true);
  });

  it('has riskLevel write', () => {
    const { client } = makeMockClient();
    expect(createReplyMessageTool(client).riskLevel).toBe('write');
  });
});

describe('outlook_forward_message', () => {
  it('posts recipients and comment to /forward', async () => {
    const req = makeMockRequest();
    req.post.mockResolvedValueOnce(undefined);
    const { client } = makeMockClient({ '/me/messages/m-1/forward': req });

    const tool = createForwardMessageTool(client);
    const result = await tool.execute(
      { message_id: 'm-1', to: 'x@example.com', comment: 'FYI' },
      {} as never,
    );

    expect(result.sent).toBe(true);
    expect(req.post).toHaveBeenCalledWith({
      comment: 'FYI',
      toRecipients: [{ emailAddress: { address: 'x@example.com' } }],
    });
  });

  it('has riskLevel write', () => {
    const { client } = makeMockClient();
    expect(createForwardMessageTool(client).riskLevel).toBe('write');
  });
});

describe('outlook_delete_message', () => {
  it('moves the message to deleteditems and returns the new id', async () => {
    const req = makeMockRequest();
    req.post.mockResolvedValueOnce({ id: 'm-1-moved' });
    const { client } = makeMockClient({ '/me/messages/m-1/move': req });

    const tool = createDeleteMessageTool(client);
    const result = await tool.execute({ message_id: 'm-1' }, {} as never);

    expect(result).toEqual({ deleted: true, messageId: 'm-1', newMessageId: 'm-1-moved' });
    expect(req.post).toHaveBeenCalledWith({ destinationId: 'deleteditems' });
  });

  it('has riskLevel write (reversible — unlike outlook_delete_draft)', () => {
    const { client } = makeMockClient();
    expect(createDeleteMessageTool(client).riskLevel).toBe('write');
  });
});

describe('outlook_update_message', () => {
  it('patches isRead', async () => {
    const req = makeMockRequest();
    req.patch.mockResolvedValueOnce({ id: 'm-1', isRead: true, categories: [] });
    const { client } = makeMockClient({ '/me/messages/m-1': req });

    const tool = createUpdateMessageTool(client);
    const result = await tool.execute({ message_id: 'm-1', is_read: true }, {} as never);

    expect(result.isRead).toBe(true);
    expect(req.patch).toHaveBeenCalledWith({ isRead: true });
  });

  it('patches categories as a full replacement', async () => {
    const req = makeMockRequest();
    req.patch.mockResolvedValueOnce({ id: 'm-1', isRead: false, categories: ['Blue'] });
    const { client } = makeMockClient({ '/me/messages/m-1': req });

    const tool = createUpdateMessageTool(client);
    const result = await tool.execute({ message_id: 'm-1', categories: ['Blue'] }, {} as never);

    expect(result.categories).toEqual(['Blue']);
    expect(req.patch).toHaveBeenCalledWith({ categories: ['Blue'] });
  });

  it('throws a validation error when neither is_read nor categories is provided', async () => {
    const { client } = makeMockClient();
    const tool = createUpdateMessageTool(client);
    await expect(tool.execute({ message_id: 'm-1' }, {} as never)).rejects.toMatchObject({
      code: 'outlook_validation_error',
    });
  });

  it('has riskLevel write', () => {
    const { client } = makeMockClient();
    expect(createUpdateMessageTool(client).riskLevel).toBe('write');
  });
});

describe('outlook_move_message', () => {
  it('moves to the given destination folder and returns the new id', async () => {
    const req = makeMockRequest();
    req.post.mockResolvedValueOnce({ id: 'm-1-in-archive' });
    const { client } = makeMockClient({ '/me/messages/m-1/move': req });

    const tool = createMoveMessageTool(client);
    const result = await tool.execute(
      { message_id: 'm-1', destination_folder_id: 'archive' },
      {} as never,
    );

    expect(result).toEqual({
      messageId: 'm-1',
      newMessageId: 'm-1-in-archive',
      destinationFolderId: 'archive',
    });
    expect(req.post).toHaveBeenCalledWith({ destinationId: 'archive' });
  });

  it('has riskLevel write', () => {
    const { client } = makeMockClient();
    expect(createMoveMessageTool(client).riskLevel).toBe('write');
  });
});
