// @nodal-agents/adapter-outlook-mail — folder tool tests

import { describe, it, expect } from 'vitest';
import { makeMockRequest, makeMockClient } from '../mock-client';
import { createListFoldersTool } from '../../tools/folders';

describe('outlook_list_folders', () => {
  it('lists mail folders with item counts', async () => {
    const req = makeMockRequest();
    req.get.mockResolvedValueOnce({
      value: [
        {
          id: 'inbox-id',
          displayName: 'Inbox',
          parentFolderId: 'root',
          unreadItemCount: 3,
          totalItemCount: 42,
        },
      ],
    });
    const { client, api } = makeMockClient({ '/me/mailFolders': req });

    const tool = createListFoldersTool(client);
    const result = await tool.execute({}, {} as never);

    expect(api).toHaveBeenCalledWith('/me/mailFolders');
    expect(result.total).toBe(1);
    expect(result.folders[0]).toEqual({
      id: 'inbox-id',
      displayName: 'Inbox',
      parentFolderId: 'root',
      unreadItemCount: 3,
      totalItemCount: 42,
    });
  });

  it('maps a 403 GraphError to outlook_forbidden', async () => {
    const req = makeMockRequest();
    req.get.mockRejectedValueOnce({ statusCode: 403, message: 'ErrorAccessDenied' });
    const { client } = makeMockClient({ '/me/mailFolders': req });

    const tool = createListFoldersTool(client);
    await expect(tool.execute({}, {} as never)).rejects.toMatchObject({
      code: 'outlook_forbidden',
    });
  });

  it('has riskLevel read', () => {
    const { client } = makeMockClient();
    expect(createListFoldersTool(client).riskLevel).toBe('read');
  });
});
