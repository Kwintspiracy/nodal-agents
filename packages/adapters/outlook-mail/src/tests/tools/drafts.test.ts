// @nodal-agents/adapter-outlook-mail — draft tool tests

import { describe, it, expect } from 'vitest';
import { makeMockRequest, makeMockClient } from '../mock-client';
import {
  createListDraftsTool,
  createCreateDraftTool,
  createUpdateDraftTool,
  createSendDraftTool,
  createDeleteDraftTool,
} from '../../tools/drafts';

describe('outlook_list_drafts', () => {
  it('lists drafts from the well-known drafts folder', async () => {
    const req = makeMockRequest();
    req.get.mockResolvedValueOnce({
      value: [
        {
          id: 'd-1',
          toRecipients: [{ emailAddress: { address: 'a@example.com' } }],
          subject: 'Draft subject',
          bodyPreview: 'preview',
        },
      ],
    });
    const { client, api } = makeMockClient({ '/me/mailFolders/drafts/messages': req });

    const tool = createListDraftsTool(client);
    const result = await tool.execute({}, {} as never);

    expect(api).toHaveBeenCalledWith('/me/mailFolders/drafts/messages');
    expect(result.total).toBe(1);
    expect(result.drafts[0]).toEqual({
      draftId: 'd-1',
      to: 'a@example.com',
      subject: 'Draft subject',
      bodyPreview: 'preview',
    });
  });

  it('maps a 401 GraphError to outlook_unauthorized', async () => {
    const req = makeMockRequest();
    req.get.mockRejectedValueOnce({ statusCode: 401, message: 'InvalidAuthenticationToken' });
    const { client } = makeMockClient({ '/me/mailFolders/drafts/messages': req });

    const tool = createListDraftsTool(client);
    await expect(tool.execute({}, {} as never)).rejects.toMatchObject({
      code: 'outlook_unauthorized',
    });
  });

  it('has riskLevel read', () => {
    const { client } = makeMockClient();
    expect(createListDraftsTool(client).riskLevel).toBe('read');
  });
});

describe('outlook_create_draft', () => {
  it('posts a new message and returns the draft id', async () => {
    const req = makeMockRequest();
    req.post.mockResolvedValueOnce({ id: 'd-1', subject: 'New draft' });
    const { client } = makeMockClient({ '/me/messages': req });

    const tool = createCreateDraftTool(client);
    const result = await tool.execute(
      { to: 'a@example.com', subject: 'New draft', body: 'Body text' },
      {} as never,
    );

    expect(result).toEqual({ draftId: 'd-1', subject: 'New draft' });
    const [body] = req.post.mock.calls[0] as [
      { subject: string; body: { contentType: string; content: string } },
    ];
    expect(body.subject).toBe('New draft');
    expect(body.body).toEqual({ contentType: 'text', content: 'Body text' });
  });

  it('includes base64 file attachments in the create payload', async () => {
    const req = makeMockRequest();
    req.post.mockResolvedValueOnce({ id: 'd-2', subject: 'With attachment' });
    const { client } = makeMockClient({ '/me/messages': req });

    const tool = createCreateDraftTool(client);
    await tool.execute(
      {
        to: 'a@example.com',
        subject: 'With attachment',
        body: 'Body',
        attachments: [{ filename: 'a.txt', content: 'hello' }],
      },
      {} as never,
    );

    const [body] = req.post.mock.calls[0] as [
      { attachments: Array<{ name: string; contentBytes: string }> },
    ];
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0]?.name).toBe('a.txt');
    expect(body.attachments[0]?.contentBytes).toBe(
      Buffer.from('hello', 'utf-8').toString('base64'),
    );
  });

  it('has riskLevel write', () => {
    const { client } = makeMockClient();
    expect(createCreateDraftTool(client).riskLevel).toBe('write');
  });
});

describe('outlook_update_draft', () => {
  it('patches only the provided fields', async () => {
    const req = makeMockRequest();
    req.patch.mockResolvedValueOnce({ id: 'd-1' });
    const { client } = makeMockClient({ '/me/messages/d-1': req });

    const tool = createUpdateDraftTool(client);
    const result = await tool.execute({ draft_id: 'd-1', subject: 'Updated subject' }, {} as never);

    expect(result.draftId).toBe('d-1');
    expect(req.patch).toHaveBeenCalledWith({ subject: 'Updated subject' });
  });

  it('adds new attachments via a separate call without touching the message fields', async () => {
    const patchReq = makeMockRequest();
    const attReq = makeMockRequest();
    attReq.post.mockResolvedValueOnce({ id: 'att-new' });
    const { client, api } = makeMockClient({
      '/me/messages/d-1': patchReq,
      '/me/messages/d-1/attachments': attReq,
    });

    const tool = createUpdateDraftTool(client);
    await tool.execute(
      { draft_id: 'd-1', attachments: [{ filename: 'b.txt', content: 'data' }] },
      {} as never,
    );

    expect(api).toHaveBeenCalledWith('/me/messages/d-1/attachments');
    expect(attReq.post).toHaveBeenCalledTimes(1);
    expect(patchReq.patch).not.toHaveBeenCalled();
  });

  it('has riskLevel write', () => {
    const { client } = makeMockClient();
    expect(createUpdateDraftTool(client).riskLevel).toBe('write');
  });

  // review MINOR-3: an empty patch and no attachments must fail loud, not
  // silently report success with no PATCH/POST ever sent.
  it('throws a validation error when neither fields nor attachments are provided', async () => {
    const { client, api } = makeMockClient();
    const tool = createUpdateDraftTool(client);

    await expect(tool.execute({ draft_id: 'd-1' }, {} as never)).rejects.toMatchObject({
      code: 'outlook_validation_error',
    });
    expect(api).not.toHaveBeenCalled();
  });

  it('throws the same validation error when attachments is an empty array', async () => {
    const { client } = makeMockClient();
    const tool = createUpdateDraftTool(client);

    await expect(
      tool.execute({ draft_id: 'd-1', attachments: [] }, {} as never),
    ).rejects.toMatchObject({
      code: 'outlook_validation_error',
    });
  });
});

describe('outlook_send_draft', () => {
  it('posts to /send and reports sent', async () => {
    const req = makeMockRequest();
    req.post.mockResolvedValueOnce(undefined);
    const { client } = makeMockClient({ '/me/messages/d-1/send': req });

    const tool = createSendDraftTool(client);
    const result = await tool.execute({ draft_id: 'd-1' }, {} as never);

    expect(result).toEqual({ sent: true, draftId: 'd-1' });
  });

  it('maps a 404 GraphError to outlook_not_found', async () => {
    const req = makeMockRequest();
    req.post.mockRejectedValueOnce({ statusCode: 404, message: 'ErrorItemNotFound' });
    const { client } = makeMockClient({ '/me/messages/missing/send': req });

    const tool = createSendDraftTool(client);
    await expect(tool.execute({ draft_id: 'missing' }, {} as never)).rejects.toMatchObject({
      code: 'outlook_not_found',
    });
  });

  it('has riskLevel destructive', () => {
    const { client } = makeMockClient();
    expect(createSendDraftTool(client).riskLevel).toBe('destructive');
  });
});

describe('outlook_delete_draft', () => {
  it('permanently deletes the draft', async () => {
    const req = makeMockRequest();
    req.delete.mockResolvedValueOnce(undefined);
    const { client } = makeMockClient({ '/me/messages/d-1': req });

    const tool = createDeleteDraftTool(client);
    const result = await tool.execute({ draft_id: 'd-1' }, {} as never);

    expect(result).toEqual({ deleted: true, draftId: 'd-1' });
    expect(req.delete).toHaveBeenCalledTimes(1);
  });

  it('maps a 404 GraphError to outlook_not_found', async () => {
    const req = makeMockRequest();
    req.delete.mockRejectedValueOnce({ statusCode: 404, message: 'ErrorItemNotFound' });
    const { client } = makeMockClient({ '/me/messages/missing': req });

    const tool = createDeleteDraftTool(client);
    await expect(tool.execute({ draft_id: 'missing' }, {} as never)).rejects.toMatchObject({
      code: 'outlook_not_found',
    });
  });

  it('has riskLevel destructive', () => {
    const { client } = makeMockClient();
    expect(createDeleteDraftTool(client).riskLevel).toBe('destructive');
  });
});
