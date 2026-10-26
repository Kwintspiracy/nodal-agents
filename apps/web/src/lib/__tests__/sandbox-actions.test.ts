// sandbox-actions.test.ts — Réglages → Safety → Sandbox (#876), ses gestes en
// VRAIE base : l'interrupteur et les dossiers permis sont écrits par les vraies
// actions et relus par le lecteur même du runner (`readWorkspaceSandbox`).
// La lecture de l'état passe par le runner : sa réponse est simulée au niveau
// de `fetch`, et l'action doit la valider, pas la croire.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { readWorkspaceSandbox, setWorkspaceSandboxFolders } from '@nodal-agents/db';
import { toolCacheRoot } from '@nodal-agents/sandbox';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
/** Qui appelle : le propriétaire de l'espace, sauf quand un test dit autrement. */
let caller = { userId: '', entityId: '' };

vi.mock('@/lib/server.ts', () => ({
  getDb: () => testDb,
  getAuthProvider: () => ({ name: 'local-trust' }),
  applyActiveEntity: (session: { userId: string; entityId: string }) => session,
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@nodal-agents/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/auth')>();
  return { ...actual, requireAuth: async () => caller };
});
vi.mock('@/lib/env.ts', () => ({
  env: { RUNNER_URL: 'http://127.0.0.1:39999', WORKER_SECRET: 'test-secret' },
}));

const A = await import('../sandbox-actions.ts');

const dirs: string[] = [];
const folder = (name: string): string => {
  const d = mkdtempSync(join(tmpdir(), `nodal-sbx-act-${name}-`));
  dirs.push(d);
  return d;
};
const stored = () => readWorkspaceSandbox(testDb, seed.entityId);

beforeAll(async () => {
  testDb = (await spinUpTestDb()).db;
  seed = await seedMinimal(testDb);
});
beforeEach(async () => {
  caller = { userId: seed.userId, entityId: seed.entityId };
  await setWorkspaceSandboxFolders(testDb, seed.entityId, { added: [], removed: [] });
});
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('the sandbox switch, persisted @cap:executer-une-commande/ecran', () => {
  it('the owner turns it off and on; the base says so, read by the runner reader', async () => {
    expect(await A.setSandboxEnabledAction({ enabled: false })).toEqual({
      ok: true,
      data: undefined,
    });
    expect((await stored()).enabled).toBe(false);
    expect((await A.setSandboxEnabledAction({ enabled: true })).ok).toBe(true);
    expect((await stored()).enabled).toBe(true);
  });

  it('anyone else is refused, and nothing changes', async () => {
    caller = { userId: '00000000-0000-4000-8000-000000000001', entityId: seed.entityId };
    expect(await A.setSandboxEnabledAction({ enabled: false })).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    expect((await stored()).enabled).toBe(true);
  });
});

describe('the allowed folders, persisted as gestures only @cap:executer-une-commande/ecran', () => {
  it('adds a real folder; adding it again is refused as already allowed', async () => {
    const d = folder('add');
    expect(await A.addSandboxFolderAction({ path: d })).toEqual({
      ok: true,
      data: { kind: 'added' },
    });
    expect((await stored()).folders).toEqual({ added: [d], removed: [] });
    expect(await A.addSandboxFolderAction({ path: d })).toMatchObject({
      ok: false,
      code: 'already_allowed',
    });
  });

  it('refuses the data folder of Nodal and any folder under it, with its code and the folder that holds it, writing nothing', async () => {
    const data = join(homedir(), '.nodalai');
    for (const p of [data, join(data, 'workspaces')]) {
      const r = await A.addSandboxFolderAction({ path: p });
      expect(r).toMatchObject({
        ok: true,
        data: { kind: 'refused', code: 'SANDBOX_REACH_IS_NODAL_HOME' },
      });
      expect(r.ok && r.data.kind === 'refused' && resolve(r.data.within)).toBe(resolve(data));
    }
    expect((await stored()).folders).toEqual({ added: [], removed: [] });
  });

  it('a relative path or a missing folder is refused', async () => {
    expect(await A.addSandboxFolderAction({ path: 'relative/dir' })).toMatchObject({
      ok: false,
      code: 'not_absolute',
    });
    expect(
      await A.addSandboxFolderAction({ path: join(tmpdir(), 'nodal-no-such-folder-876') }),
    ).toMatchObject({ ok: false, code: 'not_found' });
    expect((await stored()).folders.added).toEqual([]);
  });

  it('a drive root asks for a confirmation first, and is written only once confirmed', async () => {
    const root = resolve('/');
    expect(await A.addSandboxFolderAction({ path: root })).toEqual({
      ok: true,
      data: { kind: 'confirm', broad: 'volume-root' },
    });
    expect((await stored()).folders.added).toEqual([]);
    expect(await A.addSandboxFolderAction({ path: root, confirmedBroad: true })).toEqual({
      ok: true,
      data: { kind: 'added' },
    });
    expect((await stored()).folders.added).toEqual([root]);
  });

  it('the home folder asks for a confirmation too', async () => {
    expect(await A.addSandboxFolderAction({ path: homedir() })).toEqual({
      ok: true,
      data: { kind: 'confirm', broad: 'home' },
    });
  });

  it('removing an added folder forgets it; removing a detected one records the removal; adding it back restores it', async () => {
    const mine = folder('mine');
    const detected = folder('detected');
    await A.addSandboxFolderAction({ path: mine });
    expect((await A.removeSandboxFolderAction({ path: mine })).ok).toBe(true);
    expect((await A.removeSandboxFolderAction({ path: detected })).ok).toBe(true);
    expect((await stored()).folders).toEqual({ added: [], removed: [detected] });
    expect(await A.addSandboxFolderAction({ path: detected })).toEqual({
      ok: true,
      data: { kind: 'restored' },
    });
    expect((await stored()).folders).toEqual({ added: [], removed: [] });
    await A.removeSandboxFolderAction({ path: detected });
    expect((await A.restoreSandboxFolderAction({ path: detected })).ok).toBe(true);
    expect((await stored()).folders.removed).toEqual([]);
  });

  it('the tool cache cannot be removed, and the reason is said', async () => {
    const r = await A.removeSandboxFolderAction({ path: toolCacheRoot() });
    expect(r).toMatchObject({ ok: false, code: 'tool_cache_required' });
    expect(r.ok === false && r.message).toContain('npm and pip start from an empty cache');
    expect((await stored()).folders.removed).toEqual([]);
  });
});

describe('getSandboxAction reads the runner and checks its answer @cap:executer-une-commande/ecran', () => {
  const STATE = {
    platform: 'win32',
    status: { state: 'available', backend: 'mxc-processcontainer' },
    enabled: true,
    allowedFolders: [{ path: 'C:\\cache', source: 'tool-cache', state: 'allowed' }],
    agentFolders: [],
    agentsWithoutFolder: [],
    writableFolderCount: 1,
    sharedFolder: null,
    readRefused: ['C:\\Users\\me\\.nodalai'],
    network: { deniedPorts: [3000, 3001, 25444] },
  };

  it('asks for the workspace of the session, and adds who may change it', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(STATE), { status: 200 });
    });
    expect(await A.getSandboxAction()).toEqual({ ok: true, data: { ...STATE, isOwner: true } });
    expect(urls).toEqual([`http://127.0.0.1:39999/api/sandbox?entityId=${seed.entityId}`]);
  });

  it('an answer of another shape is an error said, never half a screen', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ status: 'fine' }), { status: 200 }),
    );
    expect(await A.getSandboxAction()).toMatchObject({ ok: false, code: 'runner_contract' });
  });

  it('a refusal of the runner keeps its code; an unreachable runner is said', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ error: 'SANDBOX_SETTINGS_UNREADABLE' }), { status: 500 }),
    );
    expect(await A.getSandboxAction()).toMatchObject({
      ok: false,
      code: 'SANDBOX_SETTINGS_UNREADABLE',
    });
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    expect(await A.getSandboxAction()).toMatchObject({ ok: false, code: 'runner_unreachable' });
  });
});
