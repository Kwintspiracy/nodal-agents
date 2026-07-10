// delivery-guard.test.ts — shared boundary checks used by the 6 outbound
// Telegram delivery tools (resolveBotToken, resolveRecipientChatId F1,
// assertLocalSourceAllowed F2, fetchBoundedUrl F3).
//
// Coverage:
//   resolveBotToken
//     - ctx.resolvedTelegramBotToken wins, no DB lookup
//     - falls back to the agent's own DB row
//     - undefined when neither is configured
//   resolveRecipientChatId (F1)
//     - no chatId anywhere → throws the caller's error name, no DB lookup
//     - omitted chatId + jobChatId set → returns it, no DB lookup
//     - explicit chatId === jobChatId → returns it, no DB lookup
//     - explicit chatId allowed (isChatAllowed true) → returns it, called with right params
//     - explicit chatId NOT allowed → throws telegram_chat_not_allowed
//   resolveRecipientChatId — per-job delivery ceiling (L4)
//     - 30 resolutions on one jobId succeed, the 31st throws telegram_send_rate_limited
//       without calling isChatAllowed
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
import { mkdtemp, writeFile, rm, symlink, mkdir } from 'node:fs/promises';
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
// isChatAllowed is mocked here as the authorization BOUNDARY — its own DB logic
// is covered separately in packages/db/src/tests/telegram-allowed-queries.test.ts.

const { isChatAllowedMock } = vi.hoisted(() => ({ isChatAllowedMock: vi.fn() }));

vi.mock('@nodal-agents/db', () => {
  const agents = { telegramBotToken: 'telegram_bot_token', id: 'id' };
  const eq = (col: unknown, val: unknown) => ({ col, val });
  return { agents, eq, isChatAllowed: isChatAllowedMock };
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeFakeDb(rows: unknown[]) {
  return {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(rows),
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
  it('returns ctx.resolvedTelegramBotToken without querying the DB', async () => {
    const db = makeFakeDb([{ telegramBotToken: 'from-db' }]);
    const ctx = makeCtx({
      resolvedTelegramBotToken: 'resolved-token',
      db: db as unknown as ToolContext['db'],
    });

    await expect(resolveBotToken(ctx)).resolves.toBe('resolved-token');
    expect(db.select).not.toHaveBeenCalled();
  });

  it("falls back to the agent's own DB row when ctx.resolvedTelegramBotToken is absent", async () => {
    const ctx = makeCtx({
      db: makeFakeDb([{ telegramBotToken: 'agent-token' }]) as unknown as ToolContext['db'],
    });

    await expect(resolveBotToken(ctx)).resolves.toBe('agent-token');
  });

  it('returns undefined when neither is configured', async () => {
    const ctx = makeCtx({ db: makeFakeDb([]) as unknown as ToolContext['db'] });

    await expect(resolveBotToken(ctx)).resolves.toBeUndefined();
  });
});

// ─── resolveRecipientChatId (F1) ────────────────────────────────────────────

describe('resolveRecipientChatId', () => {
  beforeAll(() => {
    isChatAllowedMock.mockResolvedValue(true);
  });

  it('throws the caller error name when no chatId anywhere', async () => {
    const ctx = makeCtx({ jobChatId: null });

    await expect(resolveRecipientChatId(undefined, ctx, 'my_no_recipient')).rejects.toMatchObject({
      name: 'my_no_recipient',
    });
    expect(isChatAllowedMock).not.toHaveBeenCalled();
  });

  it('falls back to ctx.jobChatId without an allow-list lookup', async () => {
    isChatAllowedMock.mockClear();
    const ctx = makeCtx({ jobChatId: '111' });

    await expect(resolveRecipientChatId(undefined, ctx, 'no_recipient')).resolves.toBe('111');
    expect(isChatAllowedMock).not.toHaveBeenCalled();
  });

  it('allows an explicit chatId equal to ctx.jobChatId without a lookup', async () => {
    isChatAllowedMock.mockClear();
    const ctx = makeCtx({ jobChatId: '111' });

    await expect(resolveRecipientChatId('111', ctx, 'no_recipient')).resolves.toBe('111');
    expect(isChatAllowedMock).not.toHaveBeenCalled();
  });

  it('queries isChatAllowed for a divergent explicit chatId and returns it when allowed', async () => {
    isChatAllowedMock.mockClear();
    isChatAllowedMock.mockResolvedValueOnce(true);
    const ctx = makeCtx({ jobChatId: '111', entityId: 'entity-xyz', agentId: 'agent-abc' });

    await expect(resolveRecipientChatId('222', ctx, 'no_recipient')).resolves.toBe('222');
    expect(isChatAllowedMock).toHaveBeenCalledWith(ctx.db, {
      entityId: 'entity-xyz',
      agentId: 'agent-abc',
      chatId: '222',
    });
  });

  it('throws telegram_chat_not_allowed when isChatAllowed resolves false', async () => {
    isChatAllowedMock.mockClear();
    isChatAllowedMock.mockResolvedValueOnce(false);
    const ctx = makeCtx({ jobChatId: '111' });

    await expect(resolveRecipientChatId('222', ctx, 'no_recipient')).rejects.toMatchObject({
      name: 'telegram_chat_not_allowed',
    });
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
    rootDir = await mkdtemp(path.join(tmpdir(), 'dg-confinement-'));

    // workspaceDir/skillStoreDir live OUTSIDE the OS temp dir (inside the
    // package's own checkout) — tmpdir() is unconditionally an allowed root,
    // so nesting them under it would make the "outside every root" and
    // "prefix trick" tests trivially pass for the wrong reason.
    outsideDir = path.join(process.cwd(), '.dg-confinement-outside-fixture');
    workspaceDir = path.join(outsideDir, 'workspace');
    skillStoreDir = path.join(outsideDir, 'skills');
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(skillStoreDir, { recursive: true });
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
