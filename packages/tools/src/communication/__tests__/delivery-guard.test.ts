// delivery-guard.test.ts — shared boundary checks used by the 6 outbound
// delivery tools (resolveBotToken, resolveChannelForJob, resolveRecipientChatId
// F1, assertLocalSourceAllowed F2, fetchBoundedUrl F3).
//
// Coverage:
//   resolveBotToken
//     - ctx.resolvedTelegramBotToken wins, no DB lookup
//     - falls back to the agent's own DB row
//     - undefined when neither is configured
//   resolveRecipientChatId (F1) — channel-parametric (S3): the isConversationAllowed
//   / resolveOwnerConversation mocks below stand in for isChatAllowed /
//   resolveOwnerChatId, always called with channel: 'telegram' (ctx.jobChannel
//   unset → resolveChannelForJob defaults to 'telegram' — see resolveTransportChannel).
//     - no chatId anywhere, no owner either → throws the caller's error name
//     - no chatId anywhere, owner resolves → returns the owner chatId, isConversationAllowed
//       never called (owner is canonical, not allowlist-checked)
//     - omitted chatId + jobChatId set → returns it, owner lookup NEVER called (regression)
//     - explicit chatId === jobChatId → returns it, no DB lookup
//     - explicit chatId allowed (isConversationAllowed true) → returns it, called with right params
//     - explicit chatId NOT allowed → throws telegram_chat_not_allowed
//     - owner-fallback chatId still counted against the per-job delivery ceiling
//   resolveRecipientChatId — per-job delivery ceiling (L4)
//     - 30 resolutions on one jobId succeed, the 31st throws telegram_send_rate_limited
//       without calling isConversationAllowed
//     - two different jobIds have independent counters
//     - jobId '' is never rate-limited (regression for minimal test contexts)
//     - the tracked-job map stays bounded past 1000 distinct jobIds (oldest evicted)
//   assertLocalSourceAllowed (F2, REAL filesystem — no mocking)
//     - inside a workspace root / the skill store / the OS temp dir → returns real path
//     - outside every allowed root → throws source_path_not_allowed
//     - symlink inside an allowed root pointing outside → throws (skipIf unsupported)
//   fetchBoundedUrl (F3)
//     - non-2xx → fetch_failed
//     - link-local hostname (169.254.x.x, fe80::) → fetch_failed, fetch never called
//     - declared Content-Length over cap → throws before any read()
//     - streamed body exceeding cap → aborts (cancels the reader) before consuming the rest
//     - happy path → returns the exact bytes

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm, symlink, mkdir, realpath } from 'node:fs/promises';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  resolveBotToken,
  resolveRecipientChatId,
  assertLocalSourceAllowed,
  fetchBoundedUrl,
  resetDeliveryCounterForTests,
} from '../delivery-guard';
import type { ToolContext } from '../../types';

// ─── Mock @nodal-agents/db ─────────────────────────────────────────────────────
// isConversationAllowed is mocked here as the authorization BOUNDARY — its own
// DB logic is covered separately in packages/db/src/tests/telegram-allowed-queries.test.ts.

const {
  isChatAllowedMock,
  resolveOwnerChatIdMock,
  getBindingCredentialsMock,
  getChannelBindingMock,
} = vi.hoisted(() => ({
  isChatAllowedMock: vi.fn(),
  resolveOwnerChatIdMock: vi.fn(),
  getBindingCredentialsMock: vi.fn(),
  getChannelBindingMock: vi.fn(),
}));

vi.mock('@nodal-agents/db', () => {
  const agents = { telegramBotToken: 'telegram_bot_token', id: 'id' };
  const eq = (col: unknown, val: unknown) => ({ col, val });
  return {
    agents,
    eq,
    isConversationAllowed: isChatAllowedMock,
    resolveOwnerConversation: resolveOwnerChatIdMock,
    getBindingCredentials: getBindingCredentialsMock,
    getChannelBinding: getChannelBindingMock,
  };
});

// resolveBotToken routes the TELEGRAM path through getBindingCredentials now
// (it owns the per-channel split AND the at-rest decryption) where it used to
// read agents.telegram_bot_token inline. This reinstalls a stand-in for that
// branch: read the agent row off the fake db, return the token under
// `botToken`. Called from every beforeEach that resets the mock, so a
// cross-channel test's mockResolvedValueOnce still takes precedence.
function installTelegramBindingCredentialsDefault(): void {
  getBindingCredentialsMock.mockImplementation(
    async (db: {
      select: () => { from: () => { where: () => { limit: () => Promise<unknown[]> } } };
    }) => {
      const rows = await db.select().from().where().limit();
      const row = rows[0] as { telegramBotToken?: string | null } | undefined;
      return row?.telegramBotToken ? { botToken: row.telegramBotToken } : null;
    },
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeFakeDb(rows: unknown[]) {
  // This fake ignores the SELECT projection and returns `rows` verbatim, so a
  // row fixture must carry every key its reader asks for. resolveBotToken now
  // reads the telegram token through getBindingCredentials, which projects it
  // as `botToken`; the legacy inline query projected `telegramBotToken`. Rows
  // are normalised to carry both rather than pinning the fixture to whichever
  // query shape is current — the real projection, and the decryption the real
  // reader performs, are covered on pglite in
  // packages/db/src/tests/channel-secrets-at-rest.test.ts.
  const normalised = rows.map((r) => {
    if (r === null || typeof r !== 'object') return r;
    const row = r as Record<string, unknown>;
    if ('telegramBotToken' in row && !('botToken' in row)) {
      return { ...row, botToken: row['telegramBotToken'] };
    }
    return row;
  });
  return {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(normalised),
        }),
      }),
    })),
  };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    jobId: 'job-1',
    agentId: 'agent-1',
    entityId: 'entity-1',
    jobChatId: null,
    db: makeFakeDb([]) as unknown as ToolContext['db'],
    ...overrides,
  };
}

// ─── resolveBotToken ────────────────────────────────────────────────────────

describe('resolveBotToken', () => {
  beforeEach(() => {
    installTelegramBindingCredentialsDefault();
  });

  it("resolves the agent's OWN DB row token — no inheritance from any other agent", async () => {
    const ctx = makeCtx({
      db: makeFakeDb([{ telegramBotToken: 'agent-token' }]) as unknown as ToolContext['db'],
    });

    await expect(resolveBotToken(ctx)).resolves.toBe('agent-token');
  });

  it('returns undefined when the agent has no token configured', async () => {
    const ctx = makeCtx({ db: makeFakeDb([]) as unknown as ToolContext['db'] });

    await expect(resolveBotToken(ctx)).resolves.toBeUndefined();
  });

  // D2 (Discord ingress): a non-telegram job resolves its credential from the
  // channel_bindings row via getBindingCredentials, NOT the agents table.
  describe('discord (channel-parametric, D2)', () => {
    beforeEach(() => {
      getBindingCredentialsMock.mockReset();
      installTelegramBindingCredentialsDefault();
    });

    it("resolves the discord binding's botToken via getBindingCredentials", async () => {
      getBindingCredentialsMock.mockResolvedValueOnce({ botToken: 'discord-token' });
      const ctx = makeCtx({
        jobChannel: 'discord',
      });

      await expect(resolveBotToken(ctx)).resolves.toBe('discord-token');
      expect(getBindingCredentialsMock).toHaveBeenCalledWith(ctx.db, ctx.agentId, 'discord');
    });

    it('returns undefined when the discord binding has no credentials', async () => {
      getBindingCredentialsMock.mockResolvedValueOnce(null);
      const ctx = makeCtx({ jobChannel: 'discord' });

      await expect(resolveBotToken(ctx)).resolves.toBeUndefined();
    });
  });

  // Explicit `channel` argument (send tools' optional cross-channel target) —
  // resolveChannelForJob gates it on an ENABLED binding for that channel.
  describe('explicit channel — cross-channel target', () => {
    beforeEach(() => {
      getChannelBindingMock.mockReset();
      getBindingCredentialsMock.mockReset();
      installTelegramBindingCredentialsDefault();
    });

    it('resolves credentials for the TARGET channel when it has an enabled binding', async () => {
      getChannelBindingMock.mockResolvedValueOnce({ enabled: true });
      getBindingCredentialsMock.mockResolvedValueOnce({ botToken: 'discord-token' });
      // jobChannel is unset (defaults to telegram) — the explicit channel
      // ('discord') differs from it, so this IS a cross-channel target.
      const ctx = makeCtx();

      await expect(resolveBotToken(ctx, 'discord')).resolves.toBe('discord-token');
      expect(getChannelBindingMock).toHaveBeenCalledWith(ctx.db, ctx.agentId, 'discord');
      expect(getBindingCredentialsMock).toHaveBeenCalledWith(ctx.db, ctx.agentId, 'discord');
    });

    it('throws channel_not_connected when there is no enabled binding for the explicit channel', async () => {
      getChannelBindingMock.mockResolvedValueOnce(null);
      const ctx = makeCtx();

      await expect(resolveBotToken(ctx, 'discord')).rejects.toMatchObject({
        name: 'channel_not_connected',
      });
      expect(getBindingCredentialsMock).not.toHaveBeenCalled();
    });

    it('an explicit channel matching the job channel is byte-identical (no binding check)', async () => {
      const ctx = makeCtx({ jobChannel: 'discord' });
      getBindingCredentialsMock.mockResolvedValueOnce({ botToken: 'discord-token' });

      await expect(resolveBotToken(ctx, 'discord')).resolves.toBe('discord-token');
      expect(getChannelBindingMock).not.toHaveBeenCalled();
    });
  });

  // B1 (notify-channel-choice): ctx.notifyChannelOverride — a cron fire whose
  // schedule chose an explicit notify channel (run-schedules.ts). Wins over the
  // resolveTransportChannel(jobChannel, activeChannels) default, but a send
  // tool's OWN explicit `channel` argument still wins over the override.
  describe('notifyChannelOverride (B1)', () => {
    beforeEach(() => {
      getChannelBindingMock.mockReset();
      getBindingCredentialsMock.mockReset();
      installTelegramBindingCredentialsDefault();
    });

    it('wins over the resolveTransportChannel default when no explicit channel arg is given', async () => {
      getBindingCredentialsMock.mockResolvedValueOnce({ botToken: 'discord-token' });
      // jobChannel/activeChannels absent — the historical default would be
      // 'telegram'; notifyChannelOverride redirects it to 'discord'.
      const ctx = makeCtx({ notifyChannelOverride: 'discord' });

      await expect(resolveBotToken(ctx)).resolves.toBe('discord-token');
      expect(getBindingCredentialsMock).toHaveBeenCalledWith(ctx.db, ctx.agentId, 'discord');
      // No cross-channel binding check — override IS the job's own default channel.
      expect(getChannelBindingMock).not.toHaveBeenCalled();
    });

    it("does NOT override a send tool's own explicit channel argument", async () => {
      getChannelBindingMock.mockResolvedValueOnce({ enabled: true });
      getBindingCredentialsMock.mockResolvedValueOnce({ botToken: 'slack-token' });
      const ctx = makeCtx({ notifyChannelOverride: 'discord' });

      await expect(resolveBotToken(ctx, 'slack')).resolves.toBe('slack-token');
      expect(getChannelBindingMock).toHaveBeenCalledWith(ctx.db, ctx.agentId, 'slack');
      expect(getBindingCredentialsMock).toHaveBeenCalledWith(ctx.db, ctx.agentId, 'slack');
    });

    it('is a no-op when absent — falls through to resolveTransportChannel (regression)', async () => {
      const ctx = makeCtx({
        db: makeFakeDb([{ telegramBotToken: 'agent-token' }]) as unknown as ToolContext['db'],
      });

      await expect(resolveBotToken(ctx)).resolves.toBe('agent-token');
      // The property under test is WHICH channel was resolved, not which
      // function fetched the credential. This used to assert
      // `getBindingCredentials` was never called, which only held while the
      // telegram branch read agents.telegram_bot_token inline; that branch now
      // goes through getBindingCredentials too (it owns the at-rest
      // decryption). Asserting the channel keeps the regression this test
      // exists for — an absent override must NOT silently pick another channel.
      expect(getBindingCredentialsMock).toHaveBeenCalledWith(ctx.db, ctx.agentId, 'telegram');
      expect(getChannelBindingMock).not.toHaveBeenCalled();
    });
  });
});

// ─── resolveRecipientChatId (F1) ────────────────────────────────────────────

describe('resolveRecipientChatId', () => {
  beforeAll(() => {
    isChatAllowedMock.mockResolvedValue(true);
  });

  beforeEach(() => {
    resolveOwnerChatIdMock.mockReset();
  });

  it('throws the caller error name when no chatId anywhere and no owner either', async () => {
    resolveOwnerChatIdMock.mockResolvedValueOnce(null);
    const ctx = makeCtx({ jobChatId: null, agentId: 'agent-no-owner' });

    await expect(resolveRecipientChatId(undefined, ctx, 'my_no_recipient')).rejects.toMatchObject({
      name: 'my_no_recipient',
    });
    expect(resolveOwnerChatIdMock).toHaveBeenCalledWith(ctx.db, 'agent-no-owner', 'telegram');
    expect(isChatAllowedMock).not.toHaveBeenCalled();
  });

  it('falls back to the OWNER chat when no explicit chatId and no jobChatId (cron/unsolicited delivery)', async () => {
    isChatAllowedMock.mockClear();
    resolveOwnerChatIdMock.mockResolvedValueOnce('owner-chat-999');
    const ctx = makeCtx({ jobChatId: null, agentId: 'agent-with-owner' });

    await expect(resolveRecipientChatId(undefined, ctx, 'no_recipient')).resolves.toBe(
      'owner-chat-999',
    );
    expect(resolveOwnerChatIdMock).toHaveBeenCalledWith(ctx.db, 'agent-with-owner', 'telegram');
    // Owner is the canonical target, not a guessed/arbitrary chat — never allowlist-checked.
    expect(isChatAllowedMock).not.toHaveBeenCalled();
  });

  it('falls back to ctx.jobChatId without an allow-list lookup, and never calls the owner lookup', async () => {
    isChatAllowedMock.mockClear();
    const ctx = makeCtx({ jobChatId: '111' });

    await expect(resolveRecipientChatId(undefined, ctx, 'no_recipient')).resolves.toBe('111');
    expect(isChatAllowedMock).not.toHaveBeenCalled();
    expect(resolveOwnerChatIdMock).not.toHaveBeenCalled();
  });

  it('allows an explicit chatId equal to ctx.jobChatId without a lookup', async () => {
    isChatAllowedMock.mockClear();
    const ctx = makeCtx({ jobChatId: '111' });

    await expect(resolveRecipientChatId('111', ctx, 'no_recipient')).resolves.toBe('111');
    expect(isChatAllowedMock).not.toHaveBeenCalled();
  });

  it('queries isConversationAllowed for a divergent explicit chatId and returns it when allowed', async () => {
    isChatAllowedMock.mockClear();
    isChatAllowedMock.mockResolvedValueOnce(true);
    const ctx = makeCtx({ jobChatId: '111', entityId: 'entity-xyz', agentId: 'agent-abc' });

    await expect(resolveRecipientChatId('222', ctx, 'no_recipient')).resolves.toBe('222');
    expect(isChatAllowedMock).toHaveBeenCalledWith(ctx.db, {
      entityId: 'entity-xyz',
      agentId: 'agent-abc',
      channel: 'telegram',
      conversationId: '222',
    });
  });

  it('throws telegram_chat_not_allowed when isConversationAllowed resolves false', async () => {
    isChatAllowedMock.mockClear();
    isChatAllowedMock.mockResolvedValueOnce(false);
    const ctx = makeCtx({ jobChatId: '111' });

    await expect(resolveRecipientChatId('222', ctx, 'no_recipient')).rejects.toMatchObject({
      name: 'telegram_chat_not_allowed',
    });
  });
});

// ─── resolveRecipientChatId — explicit cross-channel target ────────────────

describe('resolveRecipientChatId — explicit cross-channel target', () => {
  beforeEach(() => {
    getChannelBindingMock.mockReset();
    getChannelBindingMock.mockResolvedValue({ enabled: true });
    isChatAllowedMock.mockReset();
    resolveOwnerChatIdMock.mockReset();
  });

  it('is ALWAYS allowlist-checked against the TARGET channel, even when the id equals ctx.jobChatId (exemption bypass)', async () => {
    isChatAllowedMock.mockResolvedValueOnce(true);
    const ctx = makeCtx({ jobChatId: '111', entityId: 'entity-xyz', agentId: 'agent-abc' });

    await expect(resolveRecipientChatId('111', ctx, 'no_recipient', 'discord')).resolves.toBe(
      '111',
    );
    expect(isChatAllowedMock).toHaveBeenCalledWith(ctx.db, {
      entityId: 'entity-xyz',
      agentId: 'agent-abc',
      channel: 'discord',
      conversationId: '111',
    });
  });

  it('throws telegram_chat_not_allowed for a cross-channel id === ctx.jobChatId that is NOT approved on the target channel', async () => {
    isChatAllowedMock.mockResolvedValueOnce(false);
    const ctx = makeCtx({ jobChatId: '111' });

    await expect(
      resolveRecipientChatId('111', ctx, 'no_recipient', 'discord'),
    ).rejects.toMatchObject({ name: 'telegram_chat_not_allowed' });
  });

  it('never falls back to ctx.jobChatId (a different channel’s id) — omitted chatId goes straight to the TARGET channel’s owner', async () => {
    resolveOwnerChatIdMock.mockResolvedValueOnce('discord-owner-chat');
    const ctx = makeCtx({ jobChatId: '111' });

    await expect(resolveRecipientChatId(undefined, ctx, 'no_recipient', 'discord')).resolves.toBe(
      'discord-owner-chat',
    );
    expect(resolveOwnerChatIdMock).toHaveBeenCalledWith(ctx.db, ctx.agentId, 'discord');
    expect(isChatAllowedMock).not.toHaveBeenCalled();
  });

  it('an explicit channel matching the job channel keeps the same-channel exemption (regression)', async () => {
    const ctx = makeCtx({ jobChatId: '111', jobChannel: 'discord' });

    await expect(resolveRecipientChatId('111', ctx, 'no_recipient', 'discord')).resolves.toBe(
      '111',
    );
    expect(isChatAllowedMock).not.toHaveBeenCalled();
  });
});

// ─── resolveRecipientChatId — notifyChannelOverride (B1) ───────────────────

describe('resolveRecipientChatId — notifyChannelOverride (B1)', () => {
  beforeEach(() => {
    resolveOwnerChatIdMock.mockReset();
    isChatAllowedMock.mockReset();
  });

  it('resolves the owner conversation on the OVERRIDE channel, not ctx.jobChatId or telegram', async () => {
    resolveOwnerChatIdMock.mockResolvedValueOnce('discord-owner-chat');
    const ctx = makeCtx({ jobChatId: null, notifyChannelOverride: 'discord' });

    await expect(resolveRecipientChatId(undefined, ctx, 'no_recipient')).resolves.toBe(
      'discord-owner-chat',
    );
    expect(resolveOwnerChatIdMock).toHaveBeenCalledWith(ctx.db, ctx.agentId, 'discord');
  });
});

// ─── resolveRecipientChatId — per-job delivery ceiling (L4) ────────────────
// Each test uses its own unique jobId(s) so the module-level counter can't
// leak across tests — resetDeliveryCounterForTests() is the belt-and-braces
// on top of that.

describe('resolveRecipientChatId — per-job delivery ceiling (L4)', () => {
  beforeEach(() => {
    resetDeliveryCounterForTests();
    isChatAllowedMock.mockClear();
    isChatAllowedMock.mockResolvedValue(true);
  });

  it('allows 30 resolutions on one jobId, then rate-limits the 31st without an isChatAllowed lookup', async () => {
    const ctx = makeCtx({ jobId: 'ceiling-job-1', jobChatId: '111' });

    for (let i = 0; i < 30; i++) {
      await expect(resolveRecipientChatId(undefined, ctx, 'no_recipient')).resolves.toBe('111');
    }

    isChatAllowedMock.mockClear();
    await expect(resolveRecipientChatId('222', ctx, 'no_recipient')).rejects.toMatchObject({
      name: 'telegram_send_rate_limited',
    });
    expect(isChatAllowedMock).not.toHaveBeenCalled();
  });

  it('tracks two different jobIds independently', async () => {
    const ctxA = makeCtx({ jobId: 'ceiling-job-a', jobChatId: '111' });
    const ctxB = makeCtx({ jobId: 'ceiling-job-b', jobChatId: '222' });

    for (let i = 0; i < 30; i++) {
      await resolveRecipientChatId(undefined, ctxA, 'no_recipient');
    }
    await expect(resolveRecipientChatId(undefined, ctxA, 'no_recipient')).rejects.toMatchObject({
      name: 'telegram_send_rate_limited',
    });

    // ctxB never sent anything — its own counter is untouched by ctxA's ceiling.
    await expect(resolveRecipientChatId(undefined, ctxB, 'no_recipient')).resolves.toBe('222');
  });

  it('never rate-limits an empty jobId (regression for minimal test contexts)', async () => {
    const ctx = makeCtx({ jobId: '', jobChatId: '111' });

    for (let i = 0; i < 40; i++) {
      await expect(resolveRecipientChatId(undefined, ctx, 'no_recipient')).resolves.toBe('111');
    }
  });

  it('counts owner-fallback resolutions against the same per-job ceiling', async () => {
    resolveOwnerChatIdMock.mockReset();
    resolveOwnerChatIdMock.mockResolvedValue('owner-chat-ceiling');
    const ctx = makeCtx({ jobId: 'ceiling-owner-job', jobChatId: null });

    for (let i = 0; i < 30; i++) {
      await expect(resolveRecipientChatId(undefined, ctx, 'no_recipient')).resolves.toBe(
        'owner-chat-ceiling',
      );
    }

    await expect(resolveRecipientChatId(undefined, ctx, 'no_recipient')).rejects.toMatchObject({
      name: 'telegram_send_rate_limited',
    });
    // The ceiling check runs BEFORE the owner lookup — the 31st call must never
    // even attempt to resolve the owner.
    expect(resolveOwnerChatIdMock).toHaveBeenCalledTimes(30);
  });

  it('keeps the tracked-job map bounded, evicting the oldest jobId once the cap is exceeded', async () => {
    // Insert 1001 distinct jobIds (one resolution each) — one past the
    // MAX_TRACKED_JOBS cap — which must evict the very first one inserted.
    for (let i = 0; i < 1001; i++) {
      const ctx = makeCtx({ jobId: `evict-job-${i}`, jobChatId: '111' });
      await resolveRecipientChatId(undefined, ctx, 'no_recipient');
    }

    // If evict-job-0 were still tracked with its prior count of 1, it would
    // still have plenty of headroom under the ceiling of 30 either way — so
    // instead assert eviction behaviorally: run it past the ceiling on its
    // own and confirm it gets the FULL 30, proving its counter restarted
    // from zero rather than continuing from before.
    const ctx0 = makeCtx({ jobId: 'evict-job-0', jobChatId: '111' });
    for (let i = 0; i < 30; i++) {
      await expect(resolveRecipientChatId(undefined, ctx0, 'no_recipient')).resolves.toBe('111');
    }
    await expect(resolveRecipientChatId(undefined, ctx0, 'no_recipient')).rejects.toMatchObject({
      name: 'telegram_send_rate_limited',
    });
  });
});

// ─── assertLocalSourceAllowed (F2, real filesystem) ────────────────────────

describe('assertLocalSourceAllowed', () => {
  let rootDir: string;
  let outsideDir: string;
  let workspaceDir: string;
  let skillStoreDir: string;

  beforeAll(async () => {
    // realpath obligatoire ici : `assertLocalSourceAllowed` rend le chemin
    // RÉSOLU (c'est le chemin vérifié, celui qu'un appelant doit ouvrir), donc
    // comparer au chemin brut suppose `realpath(x) === x`. Vrai sur Linux et
    // sur une machine où les deux formes coïncident, faux dès qu'elles
    // divergent : le runner Windows de la CI tourne sous `runneradmin`, dont
    // le dossier temporaire porte la forme courte `C:\Users\RUNNER~1\…`, et
    // les trois cas « autorisé » échouaient sur cette seule différence
    // d'écriture. macOS ferait pareil (/var → /private/var).
    rootDir = await realpath(await mkdtemp(path.join(tmpdir(), 'dg-confinement-')));

    // workspaceDir/skillStoreDir live OUTSIDE the OS temp dir (inside the
    // package's own checkout) — tmpdir() is unconditionally an allowed root,
    // so nesting them under it would make the "outside every root" and
    // "prefix trick" tests trivially pass for the wrong reason.
    outsideDir = path.join(process.cwd(), '.dg-confinement-outside-fixture');
    workspaceDir = path.join(outsideDir, 'workspace');
    skillStoreDir = path.join(outsideDir, 'skills');
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(skillStoreDir, { recursive: true });
    // Même raison que rootDir ci-dessus — mais APRÈS la création, realpath
    // échouant sur un dossier qui n'existe pas encore.
    outsideDir = await realpath(outsideDir);
    workspaceDir = await realpath(workspaceDir);
    skillStoreDir = await realpath(skillStoreDir);
  });

  afterAll(async () => {
    await rm(rootDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  it('allows a source inside a workspace root', async () => {
    const file = path.join(workspaceDir, 'photo.png');
    await writeFile(file, 'x');
    const ctx = makeCtx({ workspaces: [{ label: 'ws', path: workspaceDir }] });

    await expect(assertLocalSourceAllowed(file, ctx)).resolves.toBe(file);
  });

  it('allows a source inside the skill store', async () => {
    const file = path.join(skillStoreDir, 'asset.bin');
    await writeFile(file, 'x');
    const ctx = makeCtx({ skillStoreDir });

    await expect(assertLocalSourceAllowed(file, ctx)).resolves.toBe(file);
  });

  it('allows a source inside the OS temp dir even with no workspaces configured', async () => {
    const file = path.join(rootDir, 'in-tmp.txt');
    await writeFile(file, 'x');
    const ctx = makeCtx();

    await expect(assertLocalSourceAllowed(file, ctx)).resolves.toBe(file);
  });

  it('throws source_path_not_allowed for a source outside every allowed root', async () => {
    const file = path.join(outsideDir, 'secret.env');
    await writeFile(file, 'x');
    const ctx = makeCtx({ workspaces: [{ label: 'ws', path: workspaceDir }], skillStoreDir });

    await expect(assertLocalSourceAllowed(file, ctx)).rejects.toMatchObject({
      name: 'source_path_not_allowed',
    });
  });

  it('does not allow a sibling directory that merely shares the workspace root as a string prefix', async () => {
    // e.g. workspaceDir = ".../workspace" must NOT match ".../workspace-evil"
    const evilDir = `${workspaceDir}-evil`;
    await mkdir(evilDir, { recursive: true });
    const file = path.join(evilDir, 'payload.bin');
    await writeFile(file, 'x');
    const ctx = makeCtx({ workspaces: [{ label: 'ws', path: workspaceDir }], skillStoreDir });

    try {
      await expect(assertLocalSourceAllowed(file, ctx)).rejects.toMatchObject({
        name: 'source_path_not_allowed',
      });
    } finally {
      await rm(evilDir, { recursive: true, force: true });
    }
  });

  // Symlink-creation capability check (privileged on some Windows setups) —
  // determined once, synchronously, so it.skipIf can use it.
  const symlinkSupported = (() => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dg-symlink-check-'));
    try {
      const target = path.join(dir, 'target.txt');
      writeFileSync(target, 'x');
      symlinkSync(target, path.join(dir, 'link.txt'));
      return true;
    } catch {
      return false;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();

  it.skipIf(!symlinkSupported)(
    'blocks a symlink inside an allowed root that points outside it',
    async () => {
      const outsideTarget = path.join(outsideDir, 'symlink-target.txt');
      await writeFile(outsideTarget, 'x');
      const link = path.join(workspaceDir, 'escape-link.txt');
      await symlink(outsideTarget, link);
      const ctx = makeCtx({ workspaces: [{ label: 'ws', path: workspaceDir }] });

      try {
        await expect(assertLocalSourceAllowed(link, ctx)).rejects.toMatchObject({
          name: 'source_path_not_allowed',
        });
      } finally {
        await rm(link, { force: true });
      }
    },
  );

  // ─── Relative-path resolution (fix for the send_file ENOENT incident) ─────
  // Before this fix, a relative `source` was handed straight to realpath(),
  // which resolves against the RUNNER PROCESS's CWD — a different root than
  // file_read/file_write use (the agent's workspace). A relative filename
  // `file_write` had just accepted therefore came back ENOENT from send_file.
  // These tests exercise the real filesystem (no mocking), same as the rest
  // of this describe block, and never touch process.cwd() itself so they
  // can't leak fixtures into the repo checkout.
  describe('relative source resolution', () => {
    it('resolves a relative source against the agent workspace, not process.cwd()', async () => {
      const file = path.join(workspaceDir, 'relative-report.md');
      await writeFile(file, 'x');
      const ctx = makeCtx({ workspaces: [{ label: 'ws', path: workspaceDir }] });

      // No file named this exists anywhere near process.cwd() — if this
      // resolved against the CWD (the old, buggy behavior) it would ENOENT
      // instead of resolving to the workspace copy.
      await expect(assertLocalSourceAllowed('relative-report.md', ctx)).resolves.toBe(file);
    });

    it('throws source_path_not_allowed naming the workspace-resolved path (not the CWD) for a missing relative source', async () => {
      const ctx = makeCtx({ workspaces: [{ label: 'ws', path: workspaceDir }] });

      let rejection: Error | undefined;
      try {
        await assertLocalSourceAllowed('does-not-exist.md', ctx);
      } catch (e) {
        rejection = e as Error;
      }
      expect(rejection?.name).toBe('source_path_not_allowed');
      expect(rejection?.message).toContain('does-not-exist.md');
      // Proves the message talks about the WORKSPACE path, not the CWD.
      expect(rejection?.message.toLowerCase()).toContain(path.basename(workspaceDir).toLowerCase());
    });

    it('still blocks a relative source that tries to escape the workspace via ../..', async () => {
      const ctx = makeCtx({ workspaces: [{ label: 'ws', path: workspaceDir }] });

      await expect(assertLocalSourceAllowed('../../secret.env', ctx)).rejects.toMatchObject({
        name: 'source_path_not_allowed',
      });
    });

    it('throws source_path_not_allowed (not a raw ENOENT) for a relative source when no workspace is configured', async () => {
      const ctx = makeCtx();

      await expect(assertLocalSourceAllowed('anything.md', ctx)).rejects.toMatchObject({
        name: 'source_path_not_allowed',
      });
    });
  });
});

// ─── fetchBoundedUrl (F3) ───────────────────────────────────────────────────

const MB = 1024 * 1024;

/** A fake streamed Response whose reader yields `chunkSizes` chunks in order. */
function makeStreamedResponse(chunkSizes: number[], contentLength?: number) {
  let i = 0;
  const reader = {
    read: vi.fn(async () => {
      if (i >= chunkSizes.length) return { done: true, value: undefined };
      const size = chunkSizes[i++]!;
      return { done: false, value: new Uint8Array(size) };
    }),
    cancel: vi.fn(async () => {}),
  };
  const headers = new Headers();
  if (contentLength !== undefined) headers.set('content-length', String(contentLength));
  const response = {
    ok: true,
    status: 200,
    headers,
    body: { getReader: () => reader },
  } as unknown as Response;
  return { response, reader };
}

describe('fetchBoundedUrl', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('throws fetch_failed on a non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('nope', { status: 404 }));

    await expect(
      fetchBoundedUrl('http://127.0.0.1:8188/missing', {
        maxBytes: MB,
        tooLargeErrorName: 'too_large',
      }),
    ).rejects.toMatchObject({ name: 'fetch_failed' });
  });

  it('blocks an IPv4 link-local hostname without calling fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(
      fetchBoundedUrl('http://169.254.169.254/latest/meta-data', {
        maxBytes: MB,
        tooLargeErrorName: 'too_large',
      }),
    ).rejects.toMatchObject({ name: 'fetch_failed' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('blocks an IPv6 link-local hostname (fe80::) without calling fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(
      fetchBoundedUrl('http://[fe80::1]/x', { maxBytes: MB, tooLargeErrorName: 'too_large' }),
    ).rejects.toMatchObject({ name: 'fetch_failed' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows a loopback/localhost URL through to fetch (ComfyUI use case)', async () => {
    const { response } = makeStreamedResponse([4]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);

    const bytes = await fetchBoundedUrl('http://127.0.0.1:8188/view?filename=x.png', {
      maxBytes: MB,
      tooLargeErrorName: 'too_large',
    });
    expect(bytes.byteLength).toBe(4);
  });

  it('rejects immediately from a declared Content-Length over the cap, before any read()', async () => {
    const { response, reader } = makeStreamedResponse([1 * MB], 20 * MB);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);

    await expect(
      fetchBoundedUrl('http://127.0.0.1:8188/big', {
        maxBytes: 10 * MB,
        tooLargeErrorName: 'too_large',
      }),
    ).rejects.toMatchObject({ name: 'too_large' });
    expect(reader.read).not.toHaveBeenCalled();
  });

  it('aborts a streamed body once it exceeds the cap, without consuming the rest of the stream', async () => {
    // 3 chunks of 6 MB each = 18 MB total; cap = 10 MB. The 2nd chunk alone
    // pushes the running total (12 MB) over the cap — the 3rd must never be read.
    const { response, reader } = makeStreamedResponse([6 * MB, 6 * MB, 6 * MB]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);

    await expect(
      fetchBoundedUrl('http://127.0.0.1:8188/stream', {
        maxBytes: 10 * MB,
        tooLargeErrorName: 'too_large',
      }),
    ).rejects.toMatchObject({ name: 'too_large' });
    expect(reader.read).toHaveBeenCalledTimes(2);
    expect(reader.cancel).toHaveBeenCalledOnce();
  });

  it('returns the exact bytes on the happy path', async () => {
    const { response } = makeStreamedResponse([3, 5]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);

    const bytes = await fetchBoundedUrl('http://127.0.0.1:8188/ok', {
      maxBytes: MB,
      tooLargeErrorName: 'too_large',
    });
    expect(bytes.byteLength).toBe(8);
  });

  it('refuses to read the body when a redirect lands on a link-local address', async () => {
    // A benign-looking URL 302-ing to the cloud metadata endpoint: fetch
    // follows redirects transparently, so the pre-flight hostname check on
    // the ORIGINAL url passes — the final-url check must catch it and the
    // body must never be read.
    const { response, reader } = makeStreamedResponse([4]);
    (response as { url?: string }).url = 'http://169.254.169.254/latest/meta-data';
    const cancelSpy = vi.fn(async () => {});
    (response.body as unknown as { cancel: typeof cancelSpy }).cancel = cancelSpy;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);

    await expect(
      fetchBoundedUrl('http://innocent-cdn.example/image.png', {
        maxBytes: MB,
        tooLargeErrorName: 'too_large',
      }),
    ).rejects.toMatchObject({ name: 'fetch_failed' });
    expect(reader.read).not.toHaveBeenCalled();
  });

  it('still refuses a link-local redirect even when the body cannot be cancelled', async () => {
    // Exotic body without a cancel() — the TypeError from the best-effort
    // cancel must never swallow the security throw.
    const { response, reader } = makeStreamedResponse([4]);
    (response as { url?: string }).url = 'http://[fe80::1]/x';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);

    await expect(
      fetchBoundedUrl('http://innocent-cdn.example/image.png', {
        maxBytes: MB,
        tooLargeErrorName: 'too_large',
      }),
    ).rejects.toMatchObject({ name: 'fetch_failed' });
    expect(reader.read).not.toHaveBeenCalled();
  });
});
