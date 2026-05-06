// @nodalai/adapter-notion — user tools tests

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client } from '@notionhq/client';
import { APIResponseError, APIErrorCode } from '@notionhq/client';
import { createListUsersTool, createGetUserTool } from '../../tools/users';

function makeClient(): Client {
  return {
    users: {
      list: vi.fn(),
      retrieve: vi.fn(),
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

const fakePerson = {
  object: 'user',
  id: 'user-1',
  name: 'Alice',
  type: 'person',
  person: { email: 'alice@example.com' },
  avatar_url: 'https://example.com/avatar.png',
};

const fakeBot = {
  object: 'user',
  id: 'bot-1',
  name: 'MyBot',
  type: 'bot',
  bot: { owner: { type: 'workspace', workspace: true } },
  avatar_url: null,
};

// ── notion_list_users ─────────────────────────────────────────────────────────

describe('notion_list_users', () => {
  let client: Client;

  beforeEach(() => {
    client = makeClient();
  });

  it('returns users with type, name, and email', async () => {
    (client.users.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      results: [fakePerson, fakeBot],
      has_more: false,
      next_cursor: null,
    });

    const tool = createListUsersTool(client);
    const result = await tool.execute({ page_size: 100 }, {} as never);

    expect(result.total).toBe(2);
    expect(result.users[0]).toMatchObject({
      id: 'user-1',
      name: 'Alice',
      type: 'person',
      email: 'alice@example.com',
    });
    expect(result.users[1]).toMatchObject({
      id: 'bot-1',
      name: 'MyBot',
      type: 'bot',
      email: '',
    });
  });

  it('maps 401 to notion_unauthorized', async () => {
    (client.users.list as ReturnType<typeof vi.fn>).mockRejectedValueOnce(makeApiError(401));

    const tool = createListUsersTool(client);
    await expect(tool.execute({ page_size: 100 }, {} as never)).rejects.toMatchObject({
      code: 'notion_unauthorized',
    });
  });

  it('has riskLevel read', () => {
    expect(createListUsersTool(client).riskLevel).toBe('read');
  });
});

// ── notion_get_user ───────────────────────────────────────────────────────────

describe('notion_get_user', () => {
  let client: Client;

  beforeEach(() => {
    client = makeClient();
  });

  it('returns user details', async () => {
    (client.users.retrieve as ReturnType<typeof vi.fn>).mockResolvedValueOnce(fakePerson);

    const tool = createGetUserTool(client);
    const result = await tool.execute({ user_id: 'user-1' }, {} as never);

    expect(result.id).toBe('user-1');
    expect(result.name).toBe('Alice');
    expect(result.type).toBe('person');
    expect(result.email).toBe('alice@example.com');
    expect(result.avatar_url).toBe('https://example.com/avatar.png');
  });

  it('returns empty email for bot user', async () => {
    (client.users.retrieve as ReturnType<typeof vi.fn>).mockResolvedValueOnce(fakeBot);

    const tool = createGetUserTool(client);
    const result = await tool.execute({ user_id: 'bot-1' }, {} as never);

    expect(result.email).toBe('');
  });

  it('maps 404 to notion_not_found', async () => {
    (client.users.retrieve as ReturnType<typeof vi.fn>).mockRejectedValueOnce(makeApiError(404));

    const tool = createGetUserTool(client);
    await expect(tool.execute({ user_id: 'x' }, {} as never)).rejects.toMatchObject({
      code: 'notion_not_found',
    });
  });

  it('maps 429 to notion_rate_limited', async () => {
    (client.users.retrieve as ReturnType<typeof vi.fn>).mockRejectedValueOnce(makeApiError(429));

    const tool = createGetUserTool(client);
    await expect(tool.execute({ user_id: 'x' }, {} as never)).rejects.toMatchObject({
      code: 'notion_rate_limited',
    });
  });

  it('has riskLevel read', () => {
    expect(createGetUserTool(client).riskLevel).toBe('read');
  });
});
