// @nodalai/adapter-gmail — draft tool tests

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { gmail_v1 } from 'googleapis';
import {
  createListDraftsTool,
  createCreateDraftTool,
  createUpdateDraftTool,
  createSendDraftTool,
  createDeleteDraftTool,
} from '../../tools/drafts';

function makeGmail(): gmail_v1.Gmail {
  return {
    users: {
      messages: {
        get: vi.fn(),
      },
      drafts: {
        list: vi.fn(),
        get: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        send: vi.fn(),
        delete: vi.fn(),
      },
    },
  } as unknown as gmail_v1.Gmail;
}

describe('gmail_list_drafts', () => {
  let gmail: gmail_v1.Gmail;
  beforeEach(() => {
    gmail = makeGmail();
  });

  it('returns list of drafts with metadata', async () => {
    (gmail.users.drafts.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        drafts: [{ id: 'draft-1', message: { id: 'msg-1' } }],
        nextPageToken: null,
      },
    });
    (gmail.users.drafts.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        id: 'draft-1',
        message: {
          id: 'msg-1',
          snippet: 'Draft snippet',
          payload: {
            headers: [
              { name: 'To', value: 'alice@example.com' },
              { name: 'Subject', value: 'Draft Subject' },
            ],
          },
        },
      },
    });

    const tool = createListDraftsTool(gmail);
    const result = await tool.execute({ max_results: 10 }, {} as never);

    expect(result.total).toBe(1);
    expect(result.drafts[0]?.draftId).toBe('draft-1');
    expect(result.drafts[0]?.subject).toBe('Draft Subject');
    expect(result.drafts[0]?.to).toBe('alice@example.com');
    expect(result.drafts[0]?.snippet).toBe('Draft snippet');
  });

  it('maps 401 to gmail_unauthorized', async () => {
    (gmail.users.drafts.list as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });

    const tool = createListDraftsTool(gmail);
    await expect(tool.execute({}, {} as never)).rejects.toMatchObject({
      code: 'gmail_unauthorized',
    });
  });

  it('has riskLevel read', () => {
    expect(createListDraftsTool(gmail).riskLevel).toBe('read');
  });
});

describe('gmail_create_draft', () => {
  let gmail: gmail_v1.Gmail;
  beforeEach(() => {
    gmail = makeGmail();
  });

  it('creates a draft and returns draftId', async () => {
    (gmail.users.drafts.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { id: 'draft-1', message: { id: 'msg-1' } },
    });

    const tool = createCreateDraftTool(gmail);
    const result = await tool.execute(
      { to: 'alice@example.com', subject: 'Test Draft', body: 'Draft body.' },
      {} as never,
    );

    expect(result.draftId).toBe('draft-1');
    expect(result.messageId).toBe('msg-1');
  });

  it('calls drafts.create with raw field', async () => {
    (gmail.users.drafts.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { id: 'draft-1', message: { id: 'msg-1' } },
    });

    const tool = createCreateDraftTool(gmail);
    await tool.execute({ to: 'alice@example.com', subject: 'Test', body: 'Content' }, {} as never);

    const callArgs = (gmail.users.drafts.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      requestBody: { message: { raw: string } };
    };
    expect(typeof callArgs?.requestBody?.message?.raw).toBe('string');
  });

  it('fetches threading metadata when reply_to_message_id is provided', async () => {
    (gmail.users.messages.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        id: 'msg-1',
        threadId: 'thread-1',
        payload: {
          headers: [
            { name: 'Subject', value: 'Original' },
            { name: 'Message-ID', value: '<orig@example.com>' },
            { name: 'References', value: '' },
          ],
        },
      },
    });
    (gmail.users.drafts.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { id: 'draft-2', message: { id: 'msg-2' } },
    });

    const tool = createCreateDraftTool(gmail);
    const result = await tool.execute(
      {
        to: 'alice@example.com',
        subject: 'Re: Original',
        body: 'Reply draft.',
        reply_to_message_id: 'msg-1',
      },
      {} as never,
    );

    expect(result.draftId).toBe('draft-2');
    // Verify threadId was passed to create
    const callArgs = (gmail.users.drafts.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      requestBody: { message: { threadId?: string } };
    };
    expect(callArgs?.requestBody?.message?.threadId).toBe('thread-1');
  });

  it('maps 401 to gmail_unauthorized', async () => {
    (gmail.users.drafts.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });

    const tool = createCreateDraftTool(gmail);
    await expect(
      tool.execute({ to: 'a@example.com', subject: 'X', body: 'Y' }, {} as never),
    ).rejects.toMatchObject({ code: 'gmail_unauthorized' });
  });

  it('has riskLevel write', () => {
    expect(createCreateDraftTool(gmail).riskLevel).toBe('write');
  });
});

describe('gmail_update_draft', () => {
  let gmail: gmail_v1.Gmail;
  beforeEach(() => {
    gmail = makeGmail();
  });

  it('updates an existing draft', async () => {
    (gmail.users.drafts.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { id: 'draft-1', message: { id: 'msg-1' } },
    });

    const tool = createUpdateDraftTool(gmail);
    const result = await tool.execute(
      {
        draft_id: 'draft-1',
        to: 'alice@example.com',
        subject: 'Updated Subject',
        body: 'Updated body.',
      },
      {} as never,
    );

    expect(result.draftId).toBe('draft-1');
  });

  it('has riskLevel write', () => {
    expect(createUpdateDraftTool(gmail).riskLevel).toBe('write');
  });
});

describe('gmail_send_draft', () => {
  let gmail: gmail_v1.Gmail;
  beforeEach(() => {
    gmail = makeGmail();
  });

  it('sends a draft and returns messageId', async () => {
    (gmail.users.drafts.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { id: 'msg-sent-1', threadId: 'thread-1' },
    });

    const tool = createSendDraftTool(gmail);
    const result = await tool.execute({ draft_id: 'draft-1' }, {} as never);

    expect(result.messageId).toBe('msg-sent-1');
    expect(result.threadId).toBe('thread-1');
  });

  it('calls drafts.send with correct draft id', async () => {
    (gmail.users.drafts.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { id: 'msg-1', threadId: 't-1' },
    });

    const tool = createSendDraftTool(gmail);
    await tool.execute({ draft_id: 'draft-1' }, {} as never);

    const callArgs = (gmail.users.drafts.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      requestBody: { id: string };
    };
    expect(callArgs?.requestBody?.id).toBe('draft-1');
  });

  it('maps 404 to gmail_message_not_found', async () => {
    (gmail.users.drafts.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 404,
      message: 'Not Found',
    });

    const tool = createSendDraftTool(gmail);
    await expect(tool.execute({ draft_id: 'nonexistent' }, {} as never)).rejects.toMatchObject({
      code: 'gmail_message_not_found',
    });
  });

  it('has riskLevel write', () => {
    expect(createSendDraftTool(gmail).riskLevel).toBe('write');
  });
});

describe('gmail_delete_draft', () => {
  let gmail: gmail_v1.Gmail;
  beforeEach(() => {
    gmail = makeGmail();
  });

  it('permanently deletes a draft', async () => {
    (gmail.users.drafts.delete as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: {} });

    const tool = createDeleteDraftTool(gmail);
    const result = await tool.execute({ draft_id: 'draft-1' }, {} as never);

    expect(result.deleted).toBe(true);
    expect(result.draftId).toBe('draft-1');
  });

  it('maps 404 to gmail_message_not_found', async () => {
    (gmail.users.drafts.delete as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 404,
      message: 'Not Found',
    });

    const tool = createDeleteDraftTool(gmail);
    await expect(tool.execute({ draft_id: 'nonexistent' }, {} as never)).rejects.toMatchObject({
      code: 'gmail_message_not_found',
    });
  });

  it('has riskLevel destructive', () => {
    expect(createDeleteDraftTool(gmail).riskLevel).toBe('destructive');
  });
});
