// @nodal-agents/adapter-outlook-mail — attachment tool tests

import { describe, it, expect } from 'vitest';
import { makeMockRequest, makeMockClient } from '../mock-client';
import { createGetAttachmentTool } from '../../tools/attachments';

describe('outlook_get_attachment', () => {
  it('downloads a file attachment and returns its base64 content', async () => {
    const req = makeMockRequest();
    req.get.mockResolvedValueOnce({
      '@odata.type': '#microsoft.graph.fileAttachment',
      id: 'att-1',
      name: 'report.csv',
      contentType: 'text/csv',
      size: 5,
      contentBytes: Buffer.from('a,b,c').toString('base64'),
    });
    const { client } = makeMockClient({ '/me/messages/m-1/attachments/att-1': req });

    const tool = createGetAttachmentTool(client);
    const result = await tool.execute({ message_id: 'm-1', attachment_id: 'att-1' }, {} as never);

    expect(result.filename).toBe('report.csv');
    expect(result.mimeType).toBe('text/csv');
    expect(result.sizeBytes).toBe(5);
    expect(result.data).toBe(Buffer.from('a,b,c').toString('base64'));
  });

  it('rejects a non-file attachment (e.g. an itemAttachment) with a typed error', async () => {
    const req = makeMockRequest();
    req.get.mockResolvedValueOnce({
      '@odata.type': '#microsoft.graph.itemAttachment',
      id: 'att-2',
      name: 'Forwarded email',
    });
    const { client } = makeMockClient({ '/me/messages/m-1/attachments/att-2': req });

    const tool = createGetAttachmentTool(client);
    await expect(
      tool.execute({ message_id: 'm-1', attachment_id: 'att-2' }, {} as never),
    ).rejects.toMatchObject({
      code: 'outlook_attachment_unsupported_type',
    });
  });

  it('rejects an attachment over the 25 MB cap', async () => {
    const req = makeMockRequest();
    req.get.mockResolvedValueOnce({
      '@odata.type': '#microsoft.graph.fileAttachment',
      id: 'att-3',
      name: 'huge.bin',
      contentType: 'application/octet-stream',
      size: 30 * 1024 * 1024,
      contentBytes: 'irrelevant',
    });
    const { client } = makeMockClient({ '/me/messages/m-1/attachments/att-3': req });

    const tool = createGetAttachmentTool(client);
    await expect(
      tool.execute({ message_id: 'm-1', attachment_id: 'att-3' }, {} as never),
    ).rejects.toMatchObject({
      code: 'outlook_attachment_too_large',
    });
  });

  it('maps a 404 GraphError to outlook_not_found', async () => {
    const req = makeMockRequest();
    req.get.mockRejectedValueOnce({ statusCode: 404, message: 'ErrorItemNotFound' });
    const { client } = makeMockClient({ '/me/messages/m-1/attachments/missing': req });

    const tool = createGetAttachmentTool(client);
    await expect(
      tool.execute({ message_id: 'm-1', attachment_id: 'missing' }, {} as never),
    ).rejects.toMatchObject({
      code: 'outlook_not_found',
    });
  });

  it('has riskLevel read', () => {
    const { client } = makeMockClient();
    expect(createGetAttachmentTool(client).riskLevel).toBe('read');
  });
});
