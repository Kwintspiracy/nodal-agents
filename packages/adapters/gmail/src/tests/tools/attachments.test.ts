// @nodal-agents/adapter-gmail — attachment tool tests

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { gmail_v1 } from 'googleapis';
import { createGetAttachmentTool } from '../../tools/attachments';

function makeGmail(): gmail_v1.Gmail {
  return {
    users: {
      messages: {
        attachments: {
          get: vi.fn(),
        },
      },
    },
  } as unknown as gmail_v1.Gmail;
}

describe('gmail_get_attachment', () => {
  let gmail: gmail_v1.Gmail;
  beforeEach(() => {
    gmail = makeGmail();
  });

  it('returns attachment data', async () => {
    const fakeData = Buffer.from('PDF content here')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
    (gmail.users.messages.attachments.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        attachmentId: 'att-id-123',
        size: 16,
        data: fakeData,
      },
    });

    const tool = createGetAttachmentTool(gmail);
    const result = await tool.execute(
      {
        message_id: 'msg-1',
        attachment_id: 'att-id-123',
        filename: 'document.pdf',
      },
      {} as never,
    );

    expect(result.attachmentId).toBe('att-id-123');
    expect(result.messageId).toBe('msg-1');
    expect(result.filename).toBe('document.pdf');
    expect(result.sizeBytes).toBe(16);
    expect(result.data).toBe(fakeData);
  });

  it('throws gmail_attachment_too_large when size exceeds 25 MB', async () => {
    (gmail.users.messages.attachments.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        attachmentId: 'att-big',
        size: 26 * 1024 * 1024, // 26 MB
        data: 'fake',
      },
    });

    const tool = createGetAttachmentTool(gmail);
    await expect(
      tool.execute({ message_id: 'msg-1', attachment_id: 'att-big' }, {} as never),
    ).rejects.toMatchObject({ code: 'gmail_attachment_too_large' });
  });

  it('maps 404 to gmail_message_not_found', async () => {
    (gmail.users.messages.attachments.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 404,
      message: 'Not Found',
    });

    const tool = createGetAttachmentTool(gmail);
    await expect(
      tool.execute({ message_id: 'msg-1', attachment_id: 'att-missing' }, {} as never),
    ).rejects.toMatchObject({ code: 'gmail_message_not_found' });
  });

  it('maps 401 to gmail_unauthorized', async () => {
    (gmail.users.messages.attachments.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });

    const tool = createGetAttachmentTool(gmail);
    await expect(
      tool.execute({ message_id: 'msg-1', attachment_id: 'att-1' }, {} as never),
    ).rejects.toMatchObject({ code: 'gmail_unauthorized' });
  });

  it('has riskLevel read', () => {
    expect(createGetAttachmentTool(gmail).riskLevel).toBe('read');
  });
});
