// manager.test.ts — startSlackManager spawns one socket per enabled slack
// binding, respawns on credential rotation, and despawns on disable/removal.
// A fake `startSocket` is injected so no real @slack/bolt App / websocket
// connection is ever created — only the DB-scan/diff logic is exercised.
// Mirrors tests/channels/discord/manager.test.ts's structure.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { channelBindings, agents } from '@nodal-agents/db';
import { startSlackManager } from '../../../channels/slack/manager.ts';
import type { SlackSocketHandle, SlackSocketOpts } from '../../../channels/slack/socket.ts';
import type { RunnerDeps } from '../../../deps.ts';
import type { RunnerEnv } from '../../../env.ts';

const testEnv = { WORKER_SECRET: 's', APP_URL: 'http://localhost:3099' } as unknown as RunnerEnv;

function makeDeps(db: TestDb): RunnerDeps {
  return {
    db: db as unknown as RunnerDeps['db'],
    llmClient: {} as RunnerDeps['llmClient'],
    embeddingClient: {} as RunnerDeps['embeddingClient'],
    registry: {} as RunnerDeps['registry'],
    authProvider: {} as RunnerDeps['authProvider'],
    close: async () => {},
  };
}

/** A fake socket factory — records spawn calls, never touches the network. */
function makeFakeSocketFactory() {
  const stops: string[] = [];
  const spy = vi.fn<(opts: SlackSocketOpts) => SlackSocketHandle>((opts) => ({
    async stop() {
      stops.push(opts.agentId);
    },
  }));
  return { spy, stops };
}

let db: TestDb;
let seed: { entityId: string; agentId: string };

beforeEach(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
});

describe('startSlackManager', () => {
  it('starts with zero sockets when no binding exists', async () => {
    const { spy } = makeFakeSocketFactory();
    const manager = startSlackManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startSocket: spy,
    });
    await manager.refreshNow();
    expect(manager.activeCount()).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    await manager.stop();
  });

  it('spawns a socket for each enabled slack binding on an active agent', async () => {
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'slack',
      credentials: JSON.stringify({ botToken: 'xoxb-1', appToken: 'xapp-1' }),
      enabled: true,
    });

    const { spy } = makeFakeSocketFactory();
    const manager = startSlackManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startSocket: spy,
    });
    await manager.refreshNow();
    expect(manager.activeCount()).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({
      agentId: seed.agentId,
      botToken: 'xoxb-1',
      appToken: 'xapp-1',
    });
    await manager.stop();
    expect(manager.activeCount()).toBe(0);
  });

  it('ignores a DISABLED binding', async () => {
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'slack',
      credentials: JSON.stringify({ botToken: 'xoxb-1', appToken: 'xapp-1' }),
      enabled: false,
    });

    const { spy } = makeFakeSocketFactory();
    const manager = startSlackManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startSocket: spy,
    });
    await manager.refreshNow();
    expect(manager.activeCount()).toBe(0);
    await manager.stop();
  });

  it('ignores a binding on an INACTIVE agent', async () => {
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'slack',
      credentials: JSON.stringify({ botToken: 'xoxb-1', appToken: 'xapp-1' }),
      enabled: true,
    });
    await db.update(agents).set({ active: false }).where(eq(agents.id, seed.agentId));

    const { spy } = makeFakeSocketFactory();
    const manager = startSlackManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startSocket: spy,
    });
    await manager.refreshNow();
    expect(manager.activeCount()).toBe(0);
    await manager.stop();
  });

  it('despawns a socket when its binding is disabled after the fact', async () => {
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'slack',
      credentials: JSON.stringify({ botToken: 'xoxb-1', appToken: 'xapp-1' }),
      enabled: true,
    });

    const { spy, stops } = makeFakeSocketFactory();
    const manager = startSlackManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startSocket: spy,
    });
    await manager.refreshNow();
    expect(manager.activeCount()).toBe(1);

    await db
      .update(channelBindings)
      .set({ enabled: false })
      .where(eq(channelBindings.agentId, seed.agentId));

    await manager.refreshNow();
    expect(manager.activeCount()).toBe(0);
    expect(stops).toContain(seed.agentId);
    await manager.stop();
  });

  it('respawns a socket when the credentials rotate', async () => {
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'slack',
      credentials: JSON.stringify({ botToken: 'xoxb-old', appToken: 'xapp-1' }),
      enabled: true,
    });

    const { spy } = makeFakeSocketFactory();
    const manager = startSlackManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startSocket: spy,
    });
    await manager.refreshNow();
    expect(spy).toHaveBeenCalledTimes(1);

    await db
      .update(channelBindings)
      .set({ credentials: JSON.stringify({ botToken: 'xoxb-new', appToken: 'xapp-1' }) })
      .where(eq(channelBindings.agentId, seed.agentId));

    await manager.refreshNow();
    // Same agent, count stays 1, but the socket was respawned with the new token.
    expect(manager.activeCount()).toBe(1);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]![0]).toMatchObject({ botToken: 'xoxb-new' });

    await manager.stop();
  });

  it('skips a binding with no usable botToken credential', async () => {
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'slack',
      credentials: JSON.stringify({ appToken: 'xapp-1' }),
      enabled: true,
    });

    const { spy } = makeFakeSocketFactory();
    const manager = startSlackManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startSocket: spy,
    });
    await manager.refreshNow();
    expect(manager.activeCount()).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    await manager.stop();
  });

  it('skips a binding with no usable appToken credential', async () => {
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'slack',
      credentials: JSON.stringify({ botToken: 'xoxb-1' }),
      enabled: true,
    });

    const { spy } = makeFakeSocketFactory();
    const manager = startSlackManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startSocket: spy,
    });
    await manager.refreshNow();
    expect(manager.activeCount()).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    await manager.stop();
  });
});
