// list-conversations.test.ts — createListConversationsTool
//
// Coverage:
//   - static metadata (name, riskLevel)
//   - channel_not_connected: no enabled binding, message names connected channels
//   - channel_not_connected: no connected channels at all
//   - telegram: allowlist-only fallback (platform can't enumerate chats) —
//     rows shaped from the allowlist, approved/role derived from status
//   - discord: adapter discovery + merge — approved:true for an allowlisted
//     id, false otherwise; getAdapter/listConversations called with the right args
//   - discord: adapter with no listConversations falls back to the allowlist
//     with a platform-limitation note, never fetching credentials
//   - discord: no usable credentials → channel_not_connected
//   - whatsapp: whatsapp_not_paired from the adapter propagates as-is (fail loud)
//   - truncation: bounded at 150 rows, notes the truncation

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createListConversationsTool } from './list-conversations';
import type { ToolContext } from '../types';
import { DeliveryError } from '@nodal-agents/delivery';

// ─── Mock @nodal-agents/db ─────────────────────────────────────────────────────

const {
  getChannelBindingMock,
  listChannelBindingsMock,
  getBindingCredentialsMock,
  listAllowedConversationsMock,
} = vi.hoisted(() => ({
  getChannelBindingMock: vi.fn(),
  listChannelBindingsMock: vi.fn(),
  getBindingCredentialsMock: vi.fn(),
  listAllowedConversationsMock: vi.fn(),
}));

vi.mock('@nodal-agents/db', () => ({
  getChannelBinding: getChannelBindingMock,
  listChannelBindings: listChannelBindingsMock,
  getBindingCredentials: getBindingCredentialsMock,
  listAllowedConversations: listAllowedConversationsMock,
}));

// ─── Mock @nodal-agents/delivery (getAdapter only — DeliveryError stays real) ──

const { getAdapterMock } = vi.hoisted(() => ({
  getAdapterMock: vi.fn(),
}));

vi.mock('@nodal-agents/delivery', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodal-agents/delivery')>();
  return {
    ...actual,
    getAdapter: getAdapterMock,
  };
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    jobId: 'job-1',
    agentId: 'agent-1',
    entityId: 'entity-1',
    jobChatId: null,
    db: {} as ToolContext['db'],
    ...overrides,
  };
}

const tool = createListConversationsTool();

describe('createListConversationsTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('has correct static metadata', () => {
    expect(tool.name).toBe('list_conversations');
    expect(tool.riskLevel).toBe('read');
    expect(tool.inputSchema.safeParse({ channel: 'telegram' }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ channel: 'myspace' }).success).toBe(false);
  });

  it('throws channel_not_connected naming the channels the agent IS connected to', async () => {
    getChannelBindingMock.mockResolvedValueOnce(null);
    listChannelBindingsMock.mockResolvedValueOnce([
      { channel: 'telegram', enabled: true },
      { channel: 'slack', enabled: false },
    ]);
    const ctx = makeCtx();

    const err = (await tool.execute({ channel: 'discord' }, ctx).catch((e: unknown) => e)) as Error;
    expect(err.name).toBe('channel_not_connected');
    expect(err.message).toContain('telegram');
    expect(err.message).not.toContain('slack'); // disabled binding excluded
  });

  it('throws channel_not_connected with a no-channels message when nothing is connected at all', async () => {
    getChannelBindingMock.mockResolvedValueOnce(null);
    listChannelBindingsMock.mockResolvedValueOnce([]);
    const ctx = makeCtx();

    const err = (await tool
      .execute({ channel: 'telegram' }, ctx)
      .catch((e: unknown) => e)) as Error;
    expect(err.name).toBe('channel_not_connected');
    expect(err.message).toMatch(/no connected messaging channels/i);
  });

  describe('telegram — allowlist-only fallback (platform limitation)', () => {
    it('returns the allowlist rows shaped as conversations, with a platform-limitation note', async () => {
      getChannelBindingMock.mockResolvedValueOnce({ enabled: true });
      listAllowedConversationsMock.mockResolvedValueOnce([
        {
          conversationId: 'owner-1',
          kind: 'private',
          role: 'owner',
          status: 'active',
          requesterName: 'Alice',
        },
        {
          conversationId: 'pending-1',
          kind: 'private',
          role: 'member',
          status: 'pending',
          requesterName: 'Bob',
        },
      ]);
      const ctx = makeCtx();

      const result = await tool.execute({ channel: 'telegram' }, ctx);

      expect(result.note).toMatch(/cannot list the chats/i);
      expect(result.conversations).toEqual([
        {
          conversationId: 'owner-1',
          name: 'Alice',
          kind: 'private',
          approved: true,
          role: 'owner',
        },
        { conversationId: 'pending-1', name: 'Bob', kind: 'private', approved: false },
      ]);
      expect(getAdapterMock).not.toHaveBeenCalled();
      expect(getBindingCredentialsMock).not.toHaveBeenCalled();
    });
  });

  describe('discord — adapter discovery + merge', () => {
    it('marks a discovered conversation approved:true when allowlisted, false otherwise', async () => {
      getChannelBindingMock.mockResolvedValueOnce({ enabled: true });
      getBindingCredentialsMock.mockResolvedValueOnce({ botToken: 'discord-token' });
      listAllowedConversationsMock.mockResolvedValueOnce([
        {
          conversationId: 'chan-1',
          kind: 'channel',
          role: 'member',
          status: 'active',
          requesterName: null,
        },
      ]);
      const listConversationsMock = vi.fn().mockResolvedValueOnce([
        { conversationId: 'chan-1', name: 'general', kind: 'channel', groupName: 'My Server' },
        { conversationId: 'chan-2', name: 'random', kind: 'channel', groupName: 'My Server' },
      ]);
      getAdapterMock.mockReturnValueOnce({ listConversations: listConversationsMock });
      const ctx = makeCtx();

      const result = await tool.execute({ channel: 'discord' }, ctx);

      expect(getAdapterMock).toHaveBeenCalledWith('discord');
      expect(listConversationsMock).toHaveBeenCalledWith({ botToken: 'discord-token' });
      expect(result.conversations).toEqual([
        {
          conversationId: 'chan-1',
          name: 'general',
          kind: 'channel',
          groupName: 'My Server',
          approved: true,
          role: 'member',
        },
        {
          conversationId: 'chan-2',
          name: 'random',
          kind: 'channel',
          groupName: 'My Server',
          approved: false,
        },
      ]);
    });

    it('falls back to the allowlist with a platform-limitation note when the adapter has no listConversations', async () => {
      getChannelBindingMock.mockResolvedValueOnce({ enabled: true });
      listAllowedConversationsMock.mockResolvedValueOnce([
        {
          conversationId: 'chan-1',
          kind: 'channel',
          role: 'owner',
          status: 'active',
          requesterName: null,
        },
      ]);
      getAdapterMock.mockReturnValueOnce({});
      const ctx = makeCtx();

      const result = await tool.execute({ channel: 'discord' }, ctx);

      expect(result.note).toMatch(/does not support conversation discovery/i);
      expect(result.conversations).toEqual([
        { conversationId: 'chan-1', kind: 'channel', approved: true, role: 'owner' },
      ]);
      expect(getBindingCredentialsMock).not.toHaveBeenCalled();
    });

    it('throws channel_not_connected when the binding has no usable credentials', async () => {
      getChannelBindingMock.mockResolvedValueOnce({ enabled: true });
      listAllowedConversationsMock.mockResolvedValueOnce([]);
      getAdapterMock.mockReturnValueOnce({ listConversations: vi.fn() });
      getBindingCredentialsMock.mockResolvedValueOnce(null);
      const ctx = makeCtx();

      await expect(tool.execute({ channel: 'discord' }, ctx)).rejects.toMatchObject({
        name: 'channel_not_connected',
      });
    });
  });

  describe('whatsapp — fail loud on not-paired', () => {
    it('propagates whatsapp_not_paired from the adapter without swallowing it into the fallback', async () => {
      getChannelBindingMock.mockResolvedValueOnce({ enabled: true });
      listAllowedConversationsMock.mockResolvedValueOnce([]);
      getBindingCredentialsMock.mockResolvedValueOnce({ sessionDir: '/tmp/x' });
      getAdapterMock.mockReturnValueOnce({
        listConversations: vi
          .fn()
          .mockRejectedValueOnce(
            new DeliveryError('whatsapp_not_paired', 'whatsapp_not_paired: not linked'),
          ),
      });
      const ctx = makeCtx();

      await expect(tool.execute({ channel: 'whatsapp' }, ctx)).rejects.toMatchObject({
        code: 'whatsapp_not_paired',
      });
    });
  });

  describe('truncation', () => {
    it('bounds the result at 150 rows and notes the truncation', async () => {
      getChannelBindingMock.mockResolvedValueOnce({ enabled: true });
      const rows = Array.from({ length: 200 }, (_, i) => ({
        conversationId: `c-${i}`,
        kind: 'private',
        role: 'member',
        status: 'active',
        requesterName: null,
      }));
      listAllowedConversationsMock.mockResolvedValueOnce(rows);
      const ctx = makeCtx();

      const result = await tool.execute({ channel: 'telegram' }, ctx);

      expect(result.conversations).toHaveLength(150);
      expect(result.truncated).toBe(true);
      expect(result.note).toMatch(/truncated/i);
    });
  });
});
