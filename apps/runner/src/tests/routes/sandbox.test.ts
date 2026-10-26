// sandbox.test.ts — GET /api/sandbox (#876) : ce que le runner dit du bac à
// sable pour un espace, en codes et en chemins RÉELS — ceux de la base de test
// et d'une machine fabriquée sur le disque. La sonde est injectée (la vraie
// ouvre un conteneur MXC) ; tout le reste est le code de production.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentWorkspaces, entities, eq, sql } from '@nodal-agents/db';
import { toolCacheRoot, type SandboxStatus } from '@nodal-agents/sandbox';
import { SandboxStateSchema } from '@nodal-agents/shared';
import { sandboxRoute, type SandboxRouteSources } from '../../routes/sandbox.ts';
import type { RunnerDeps } from '../../deps.ts';
import '../../lib/runner-auth-context.ts';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let base: string;
let home: string;
let agentFolder: string;
let mine: string;

const ACTIVE: SandboxStatus = {
  state: 'available',
  backend: 'mxc-processcontainer',
  limits: ['SANDBOX_NETWORK_RAW_TCP_LOCAL: raw TCP has no route'],
};

/** Une app Hono qui pose le contexte que `requireRunnerAuth` poserait. */
function app(sources: SandboxRouteSources, caller: { trusted: boolean; entityId?: string }) {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('callerTrusted', caller.trusted);
    if (caller.entityId) c.set('callerEntityId', caller.entityId);
    await next();
  });
  a.get('/api/sandbox', (c) => sandboxRoute(c, { db: db as unknown as RunnerDeps['db'] }, sources));
  return a;
}

const sources = (status: SandboxStatus = ACTIVE): SandboxRouteSources => ({
  status: async () => status,
  env: { PORT: '3001', WEB_PORT: '3000', DATABASE_URL: 'postgres://u:p@127.0.0.1:25444/db' },
  machine: { platform: process.platform, home, env: {} },
});

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  seed = await seedMinimal(db);
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nodal-sandbox-route-')));
  home = join(base, 'home');
  agentFolder = join(base, 'project');
  mine = join(base, 'models');
  await mkdir(join(home, '.nodalai'), { recursive: true });
  await mkdir(join(home, '.ollama', 'models'), { recursive: true });
  await mkdir(agentFolder);
  await mkdir(mine);
  await db.insert(agentWorkspaces).values({
    agentId: seed.agentId,
    entityId: seed.entityId,
    label: 'project',
    path: agentFolder,
  });
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('GET /api/sandbox @cap:executer-une-commande/moteur', () => {
  it('says the state, the limits and the perimeter with the real paths of this machine', async () => {
    await db
      .update(entities)
      .set({ sandboxFolders: { added: [mine], removed: [] } })
      .where(eq(entities.id, seed.entityId));
    const res = await app(sources(), { trusted: true }).request(
      `/api/sandbox?entityId=${seed.entityId}`,
    );
    expect(res.status).toBe(200);
    const body = SandboxStateSchema.parse(await res.json());
    expect(body.status).toEqual(ACTIVE);
    expect(body.enabled).toBe(true);
    expect(body.allowedFolders).toEqual([
      { path: toolCacheRoot(), source: 'tool-cache', state: 'allowed' },
      { path: join(home, '.ollama', 'models'), source: 'ollama', state: 'allowed' },
      { path: mine, source: 'user', state: 'allowed' },
    ]);
    expect(body.agents).toEqual([
      {
        id: seed.agentId,
        name: 'Test Agent',
        runtime: 'nodal',
        folders: [{ label: 'project', path: agentFolder }],
      },
    ]);
    expect(body.sharedFolder).toMatch(new RegExp(`${seed.entityId}.shared$`));
    expect(body.readRefused).toContain(realpathSync.native(join(home, '.nodalai')));
    expect(body.network).toEqual({ deniedPorts: [3001, 3000, 25444] });
  });

  it('reads the switch from the base at every call: off is said, and so is unavailable', async () => {
    await db.update(entities).set({ sandboxEnabled: false }).where(eq(entities.id, seed.entityId));
    const res = await app(
      sources({
        state: 'unavailable',
        code: 'SANDBOX_NOT_IMPLEMENTED',
        reason: 'no sandbox backend for platform linux yet',
      }),
      { trusted: true },
    ).request(`/api/sandbox?entityId=${seed.entityId}`);
    const body = SandboxStateSchema.parse(await res.json());
    expect(body.enabled).toBe(false);
    expect(body.status).toEqual({
      state: 'unavailable',
      code: 'SANDBOX_NOT_IMPLEMENTED',
      reason: 'no sandbox backend for platform linux yet',
    });
    await db.update(entities).set({ sandboxEnabled: true }).where(eq(entities.id, seed.entityId));
  });

  it('unknown Nodal ports are said with their code, never left out', async () => {
    const res = await app({ ...sources(), env: {} }, { trusted: true }).request(
      `/api/sandbox?entityId=${seed.entityId}`,
    );
    const body = SandboxStateSchema.parse(await res.json());
    expect(body.network).toMatchObject({ code: 'SANDBOX_NODAL_PORTS_UNKNOWN' });
  });

  it('an unreadable setting answers 500 with its code, never a guessed state', async () => {
    await db.execute(
      sql`UPDATE entities SET sandbox_folders = '[]'::jsonb WHERE id = ${seed.entityId}`,
    );
    const res = await app(sources(), { trusted: true }).request(
      `/api/sandbox?entityId=${seed.entityId}`,
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'SANDBOX_SETTINGS_UNREADABLE' });
    await db
      .update(entities)
      .set({ sandboxFolders: { added: [], removed: [] } })
      .where(eq(entities.id, seed.entityId));
  });

  it('a session caller reads only its own workspace; another one is not found', async () => {
    const other = await app(sources(), {
      trusted: false,
      entityId: '00000000-0000-4000-8000-000000000000',
    }).request(`/api/sandbox?entityId=${seed.entityId}`);
    expect(other.status).toBe(404);
    const own = await app(sources(), { trusted: false, entityId: seed.entityId }).request(
      `/api/sandbox?entityId=${seed.entityId}`,
    );
    expect(own.status).toBe(200);
    const bad = await app(sources(), { trusted: true }).request('/api/sandbox?entityId=nope');
    expect(bad.status).toBe(400);
  });
});
