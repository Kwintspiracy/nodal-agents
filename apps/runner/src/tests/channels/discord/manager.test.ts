// manager.test.ts — startDiscordManager spawns one gateway per enabled discord
// binding, respawns on credential rotation, and despawns on disable/removal.
// A fake `startGateway` is injected so no real discord.js Client / network
// connection is ever created — only the DB-scan/diff logic is exercised.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { channelBindings, agents } from '@nodal-agents/db';
import { startDiscordManager } from '../../../channels/discord/manager.ts';
import type {
  DiscordGatewayHandle,
  DiscordGatewayOpts,
} from '../../../channels/discord/gateway.ts';
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

/** A fake gateway factory — records spawn calls, never touches the network. */
function makeFakeGatewayFactory() {
  const stops: string[] = [];
  const spy = vi.fn<(opts: DiscordGatewayOpts) => DiscordGatewayHandle>((opts) => ({
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

describe('startDiscordManager', () => {
  it('starts with zero gateways when no binding exists', async () => {
    const { spy } = makeFakeGatewayFactory();
    const manager = startDiscordManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startGateway: spy,
    });
    await manager.refreshNow();
    expect(manager.activeCount()).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    await manager.stop();
  });

  it('spawns a gateway for each enabled discord binding on an active agent', async () => {
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'discord',
      credentials: JSON.stringify({ botToken: 'tok-1' }),
      enabled: true,
    });

    const { spy } = makeFakeGatewayFactory();
    const manager = startDiscordManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startGateway: spy,
    });
    await manager.refreshNow();
    expect(manager.activeCount()).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({ agentId: seed.agentId, botToken: 'tok-1' });
    await manager.stop();
    expect(manager.activeCount()).toBe(0);
  });

  it('ignores a DISABLED binding', async () => {
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'discord',
      credentials: JSON.stringify({ botToken: 'tok-1' }),
      enabled: false,
    });

    const { spy } = makeFakeGatewayFactory();
    const manager = startDiscordManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startGateway: spy,
    });
    await manager.refreshNow();
    expect(manager.activeCount()).toBe(0);
    await manager.stop();
  });

  it('ignores a binding on an INACTIVE agent', async () => {
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'discord',
      credentials: JSON.stringify({ botToken: 'tok-1' }),
      enabled: true,
    });
    await db.update(agents).set({ active: false }).where(eq(agents.id, seed.agentId));

    const { spy } = makeFakeGatewayFactory();
    const manager = startDiscordManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startGateway: spy,
    });
    await manager.refreshNow();
    expect(manager.activeCount()).toBe(0);
    await manager.stop();
  });

  it('despawns a gateway when its binding is disabled after the fact', async () => {
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'discord',
      credentials: JSON.stringify({ botToken: 'tok-1' }),
      enabled: true,
    });

    const { spy, stops } = makeFakeGatewayFactory();
    const manager = startDiscordManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startGateway: spy,
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

  it('respawns a gateway when the credentials rotate', async () => {
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'discord',
      credentials: JSON.stringify({ botToken: 'tok-old' }),
      enabled: true,
    });

    const { spy } = makeFakeGatewayFactory();
    const manager = startDiscordManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startGateway: spy,
    });
    await manager.refreshNow();
    expect(spy).toHaveBeenCalledTimes(1);

    await db
      .update(channelBindings)
      .set({ credentials: JSON.stringify({ botToken: 'tok-new' }) })
      .where(eq(channelBindings.agentId, seed.agentId));

    await manager.refreshNow();
    // Same agent, count stays 1, but the gateway was respawned with the new token.
    expect(manager.activeCount()).toBe(1);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]![0]).toMatchObject({ botToken: 'tok-new' });

    await manager.stop();
  });

  it('skips a binding with no usable botToken credential', async () => {
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'discord',
      credentials: JSON.stringify({ somethingElse: 'x' }),
      enabled: true,
    });

    const { spy } = makeFakeGatewayFactory();
    const manager = startDiscordManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startGateway: spy,
    });
    await manager.refreshNow();
    expect(manager.activeCount()).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    await manager.stop();
  });

  it('one binding whose spawn throws does not abort the refresh for other bindings', async () => {
    const [agent2] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'Second Discord Agent',
        slug: `discord-agent-2-${Date.now()}`,
        personality: 'test',
      })
      .returning();

    await db.insert(channelBindings).values([
      {
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'discord',
        credentials: JSON.stringify({ botToken: 'bad-token' }),
        enabled: true,
      },
      {
        entityId: seed.entityId,
        agentId: agent2!.id,
        channel: 'discord',
        credentials: JSON.stringify({ botToken: 'good-token' }),
        enabled: true,
      },
    ]);

    const stops: string[] = [];
    const spy = vi.fn<(opts: DiscordGatewayOpts) => DiscordGatewayHandle>((opts) => {
      if (opts.botToken === 'bad-token') throw new Error('boom: gateway init failed');
      return {
        async stop() {
          stops.push(opts.agentId);
        },
      };
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const manager = startDiscordManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startGateway: spy,
    });
    await manager.refreshNow();

    // The failing binding never got an active gateway; the healthy one did.
    expect(manager.activeCount()).toBe(1);
    expect(spy.mock.calls.some(([opts]) => opts.botToken === 'good-token')).toBe(true);
    expect(
      consoleErrorSpy.mock.calls.some(
        ([msg]) =>
          typeof msg === 'string' &&
          msg.includes('[discord-manager') &&
          msg.includes('boom: gateway init failed'),
      ),
    ).toBe(true);

    consoleErrorSpy.mockRestore();
    await manager.stop();
  });
});
