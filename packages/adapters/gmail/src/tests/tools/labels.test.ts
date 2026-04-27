// @nodalai/adapter-gmail — label tool tests

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { gmail_v1 } from 'googleapis';
import {
  createListLabelsTool,
  createGetLabelTool,
  createCreateLabelTool,
  createUpdateLabelTool,
  createDeleteLabelTool,
} from '../../tools/labels.js';

function makeGmail(): gmail_v1.Gmail {
  return {
    users: {
      labels: {
        list: vi.fn(),
        get: vi.fn(),
        create: vi.fn(),
        patch: vi.fn(),
        delete: vi.fn(),
      },
    },
  } as unknown as gmail_v1.Gmail;
}

describe('gmail_list_labels', () => {
  let gmail: gmail_v1.Gmail;
  beforeEach(() => {
    gmail = makeGmail();
  });

  it('returns list of labels with counts', async () => {
    (gmail.users.labels.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        labels: [
          {
            id: 'INBOX',
            name: 'INBOX',
            type: 'system',
            messageListVisibility: 'show',
            labelListVisibility: 'labelShow',
            messagesTotal: 100,
            messagesUnread: 5,
            threadsTotal: 80,
            threadsUnread: 4,
          },
          {
            id: 'Label_123',
            name: 'Work',
            type: 'user',
            messagesTotal: 10,
            messagesUnread: 0,
            threadsTotal: 8,
            threadsUnread: 0,
          },
        ],
      },
    });

    const tool = createListLabelsTool(gmail);
    const result = await tool.execute({}, {} as never);

    expect(result.total).toBe(2);
    expect(result.labels[0]?.id).toBe('INBOX');
    expect(result.labels[0]?.messagesTotal).toBe(100);
    expect(result.labels[1]?.name).toBe('Work');
    expect(result.labels[1]?.type).toBe('user');
  });

  it('maps 401 to gmail_unauthorized', async () => {
    (gmail.users.labels.list as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });

    const tool = createListLabelsTool(gmail);
    await expect(tool.execute({}, {} as never)).rejects.toMatchObject({
      code: 'gmail_unauthorized',
    });
  });

  it('has riskLevel read', () => {
    expect(createListLabelsTool(gmail).riskLevel).toBe('read');
  });
});

describe('gmail_get_label', () => {
  let gmail: gmail_v1.Gmail;
  beforeEach(() => {
    gmail = makeGmail();
  });

  it('returns label details', async () => {
    (gmail.users.labels.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        id: 'Label_123',
        name: 'Work',
        type: 'user',
        messagesTotal: 42,
        messagesUnread: 3,
        threadsTotal: 30,
        threadsUnread: 2,
      },
    });

    const tool = createGetLabelTool(gmail);
    const result = await tool.execute({ label_id: 'Label_123' }, {} as never);

    expect(result.id).toBe('Label_123');
    expect(result.name).toBe('Work');
    expect(result.messagesTotal).toBe(42);
  });

  it('maps 404 to gmail_message_not_found', async () => {
    (gmail.users.labels.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 404,
      message: 'Not Found',
    });

    const tool = createGetLabelTool(gmail);
    await expect(tool.execute({ label_id: 'nonexistent' }, {} as never)).rejects.toMatchObject({
      code: 'gmail_message_not_found',
    });
  });

  it('has riskLevel read', () => {
    expect(createGetLabelTool(gmail).riskLevel).toBe('read');
  });
});

describe('gmail_create_label', () => {
  let gmail: gmail_v1.Gmail;
  beforeEach(() => {
    gmail = makeGmail();
  });

  it('creates a label and returns id and name', async () => {
    (gmail.users.labels.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { id: 'Label_456', name: 'Projects/NodalAI' },
    });

    const tool = createCreateLabelTool(gmail);
    const result = await tool.execute({ name: 'Projects/NodalAI' }, {} as never);

    expect(result.id).toBe('Label_456');
    expect(result.name).toBe('Projects/NodalAI');
  });

  it('uses labelShow and show as defaults', async () => {
    (gmail.users.labels.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { id: 'Label_789', name: 'Test' },
    });

    const tool = createCreateLabelTool(gmail);
    await tool.execute({ name: 'Test' }, {} as never);

    const callArgs = (gmail.users.labels.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      requestBody: { labelListVisibility: string; messageListVisibility: string };
    };
    expect(callArgs?.requestBody?.labelListVisibility).toBe('labelShow');
    expect(callArgs?.requestBody?.messageListVisibility).toBe('show');
  });

  it('maps 401 to gmail_unauthorized', async () => {
    (gmail.users.labels.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 401,
      message: 'Unauthorized',
    });

    const tool = createCreateLabelTool(gmail);
    await expect(tool.execute({ name: 'Test' }, {} as never)).rejects.toMatchObject({
      code: 'gmail_unauthorized',
    });
  });

  it('has riskLevel write', () => {
    expect(createCreateLabelTool(gmail).riskLevel).toBe('write');
  });
});

describe('gmail_update_label', () => {
  let gmail: gmail_v1.Gmail;
  beforeEach(() => {
    gmail = makeGmail();
  });

  it('updates a label', async () => {
    (gmail.users.labels.patch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { id: 'Label_123', name: 'NewName' },
    });

    const tool = createUpdateLabelTool(gmail);
    const result = await tool.execute({ label_id: 'Label_123', name: 'NewName' }, {} as never);

    expect(result.id).toBe('Label_123');
    expect(result.name).toBe('NewName');
  });

  it('has riskLevel write', () => {
    expect(createUpdateLabelTool(gmail).riskLevel).toBe('write');
  });
});

describe('gmail_delete_label', () => {
  let gmail: gmail_v1.Gmail;
  beforeEach(() => {
    gmail = makeGmail();
  });

  it('deletes a label', async () => {
    (gmail.users.labels.delete as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: {} });

    const tool = createDeleteLabelTool(gmail);
    const result = await tool.execute({ label_id: 'Label_123' }, {} as never);

    expect(result.deleted).toBe(true);
    expect(result.labelId).toBe('Label_123');
  });

  it('maps 403 to gmail_forbidden (cannot delete system labels)', async () => {
    (gmail.users.labels.delete as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 403,
      message: 'Forbidden',
    });

    const tool = createDeleteLabelTool(gmail);
    await expect(tool.execute({ label_id: 'INBOX' }, {} as never)).rejects.toMatchObject({
      code: 'gmail_forbidden',
    });
  });

  it('has riskLevel destructive', () => {
    expect(createDeleteLabelTool(gmail).riskLevel).toBe('destructive');
  });
});
