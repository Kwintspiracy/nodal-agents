// encrypted-credentials.test.ts — the channel managers against ENCRYPTED
// channel_bindings.credentials rows (encryption-at-rest, 2026-08-28).
//
// Two failure modes this pins, both of which the plaintext-era code would hit
// the moment the column became ciphertext:
//
//  1. RESPAWN LOOP. Both managers detect "the token was rotated" by hashing
//     the credential and comparing it to the running socket's hash. They
//     hashed the STORED VALUE. AES-GCM draws a fresh random IV per encryption,
//     so re-encrypting the identical token yields a different blob every time
//     — and any writer that re-saves a binding (the dashboard's
//     onConflictDoUpdate, the boot migration) would make the next 30s refresh
//     see a "rotation", tear down a healthy websocket and open a new one. On
//     a loop. The fingerprint must be taken on the decrypted credential.
//
//  2. UNDECRYPTABLE ROW KILLS THE SCAN. A binding written under a different
//     master key (restored backup, copied DB) throws on decrypt. That must
//     degrade to "this one agent has no socket, loudly logged" and leave every
//     other agent's socket running — not abort the refresh for everyone.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { channelBindings, encryptChannelCredentials } from '@nodal-agents/db';
import { encrypt, _setMasterKeyForTests } from '@nodal-agents/secrets';
import { startSlackManager } from '../../channels/slack/manager.ts';
import { startDiscordManager } from '../../channels/discord/manager.ts';
import type { SlackSocketHandle, SlackSocketOpts } from '../../channels/slack/socket.ts';
import type { DiscordGatewayHandle, DiscordGatewayOpts } from '../../channels/discord/gateway.ts';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';

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

let db: TestDb;
let seed: { entityId: string; agentId: string };

beforeEach(async () => {
  _setMasterKeyForTests(Buffer.alloc(32, 3));
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('slack manager — encrypted credentials', () => {
  function fakeSockets() {
    const stops: string[] = [];
    const spy = vi.fn<(opts: SlackSocketOpts) => SlackSocketHandle>((opts) => ({
      async stop() {
        stops.push(opts.agentId);
      },
    }));
    return { spy, stops };
  }

  it('spawns a socket with the DECRYPTED tokens', async () => {
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'slack',
      credentials: encryptChannelCredentials({ botToken: 'xoxb-secret', appToken: 'xapp-secret' }),
      enabled: true,
    });

    const { spy } = fakeSockets();
    const manager = startSlackManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startSocket: spy,
    });
    await manager.refreshNow();

    expect(spy).toHaveBeenCalledTimes(1);
    // The real tokens reach @slack/bolt — not the enc:v1 envelope.
    const opts = spy.mock.calls[0]?.[0];
    expect(opts?.botToken).toBe('xoxb-secret');
    expect(opts?.appToken).toBe('xapp-secret');
    await manager.stop();
  });

  it('does NOT respawn when the row is re-encrypted with identical tokens', async () => {
    const creds = { botToken: 'xoxb-stable', appToken: 'xapp-stable' };
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'slack',
      credentials: encryptChannelCredentials(creds),
      enabled: true,
    });

    const { spy, stops } = fakeSockets();
    const manager = startSlackManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startSocket: spy,
    });
    await manager.refreshNow();
    expect(spy).toHaveBeenCalledTimes(1);

    // Rewrite the SAME credentials — a fresh IV means a different blob.
    const rewritten = encryptChannelCredentials(creds);
    await db.update(channelBindings).set({ credentials: rewritten });
    await manager.refreshNow();

    // Still exactly one spawn and nothing was torn down.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(stops).toEqual([]);
    expect(manager.activeCount()).toBe(1);
    await manager.stop();
  });

  it('DOES respawn when the token genuinely changes', async () => {
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'slack',
      credentials: encryptChannelCredentials({ botToken: 'xoxb-old', appToken: 'xapp-1' }),
      enabled: true,
    });

    const { spy } = fakeSockets();
    const manager = startSlackManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startSocket: spy,
    });
    await manager.refreshNow();

    await db.update(channelBindings).set({
      credentials: encryptChannelCredentials({ botToken: 'xoxb-NEW', appToken: 'xapp-1' }),
    });
    await manager.refreshNow();

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]?.[0]?.botToken).toBe('xoxb-NEW');
    await manager.stop();
  });

  it('skips an undecryptable binding loudly and keeps the OTHER agent running', async () => {
    const other = await seedMinimal(db);
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'slack',
      // Written under a different master key.
      credentials: encrypt(JSON.stringify({ botToken: 'x', appToken: 'y' }), Buffer.alloc(32, 8)),
      enabled: true,
    });
    await db.insert(channelBindings).values({
      entityId: other.entityId,
      agentId: other.agentId,
      channel: 'slack',
      credentials: encryptChannelCredentials({ botToken: 'xoxb-ok', appToken: 'xapp-ok' }),
      enabled: true,
    });

    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });

    const { spy } = fakeSockets();
    const manager = startSlackManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startSocket: spy,
    });
    await manager.refreshNow();

    // The healthy agent got its socket…
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]?.agentId).toBe(other.agentId);
    // …and the broken one was named in a log, not swallowed.
    expect(errors.join('\n')).toMatch(/decrypt/i);
    expect(errors.join('\n')).toContain(seed.agentId);
    await manager.stop();
  });
});

describe('discord manager — encrypted credentials', () => {
  function fakeGateways() {
    const stops: string[] = [];
    const spy = vi.fn<(opts: DiscordGatewayOpts) => DiscordGatewayHandle>((opts) => ({
      async stop() {
        stops.push(opts.agentId);
      },
    }));
    return { spy, stops };
  }

  it('spawns a gateway with the DECRYPTED token', async () => {
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'discord',
      credentials: encryptChannelCredentials({ botToken: 'discord-secret' }),
      enabled: true,
    });

    const { spy } = fakeGateways();
    const manager = startDiscordManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startGateway: spy,
    });
    await manager.refreshNow();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]?.botToken).toBe('discord-secret');
    await manager.stop();
  });

  it('does NOT respawn when the row is re-encrypted with an identical token', async () => {
    const creds = { botToken: 'discord-stable' };
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'discord',
      credentials: encryptChannelCredentials(creds),
      enabled: true,
    });

    const { spy, stops } = fakeGateways();
    const manager = startDiscordManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startGateway: spy,
    });
    await manager.refreshNow();
    expect(spy).toHaveBeenCalledTimes(1);

    await db.update(channelBindings).set({ credentials: encryptChannelCredentials(creds) });
    await manager.refreshNow();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(stops).toEqual([]);
    await manager.stop();
  });
});
