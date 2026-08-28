// socket-lifecycle.test.ts — a Slack socket that DIES must come back.
//
// Three defects this pins, all observed on a real install (the 25/08 token
// rotation, runner.log lines 482-490):
//
//  1. UNHANDLED REJECTION. @slack/socket-mode 2.0.7 reconnects by calling
//     `delayReconnectAttempt(this.start)`, whose body is
//     `cb.apply(this).then(res)` — no `.catch`. When the retry hits an
//     UNRECOVERABLE error (`invalid_auth` after a token revocation),
//     `retrieveWSSURL` rethrows, and nothing owns that rejection: it escapes
//     as a process-level `unhandledRejection`. Our own `app.start().catch()`
//     never sees it — that promise already resolved on the first connect.
//     Fix: own the reconnect ourselves (autoReconnectEnabled: false), which
//     routes the failure back into the promise WE await.
//
//  2. A DEAD SOCKET IS NEVER RESPAWNED. spawnOne registered the socket in
//     `active` unconditionally, including when `start()` failed. The manager
//     only respawns on a CREDENTIAL CHANGE, so a socket that never connected
//     (or that disconnected for good) stayed in `active` forever and the agent
//     was silently offline. The code even carried a comment promising "will
//     retry on the manager's next refresh" — it never did.
//
//  3. A RECONNECT REUSED A STALE TOKEN. Bolt's internal reconnect re-dials
//     with the credentials captured at construction, so rotating the token
//     while the socket lived meant reconnecting with the OLD one forever.
//     Respawning through the manager re-reads the binding instead. NOTE: this
//     one gets no test of its own on purpose — a rotation ALREADY triggers a
//     respawn through the fingerprint path, so any test written for it would
//     pass with or without this change and prove nothing. What is asserted
//     below is the part that is genuinely new: the respawn after a death
//     carries the credential as currently stored.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { channelBindings, encryptChannelCredentials } from '@nodal-agents/db';
import { _setMasterKeyForTests } from '@nodal-agents/secrets';
import { startSlackManager } from '../../../channels/slack/manager.ts';
import { slackReceiverOptions } from '../../../channels/slack/socket.ts';
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

let db: TestDb;
let seed: { entityId: string; agentId: string };

beforeEach(async () => {
  _setMasterKeyForTests(Buffer.alloc(32, 5));
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
});

async function seedSlackBinding(creds: { botToken: string; appToken: string }): Promise<void> {
  await db.insert(channelBindings).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    channel: 'slack',
    credentials: encryptChannelCredentials(creds),
    enabled: true,
  });
}

/**
 * A fake socket factory that hands each spawned socket a way to report its own
 * death, exactly as the real one does once `start()` rejects or the websocket
 * closes for good.
 */
function makeFakeSockets() {
  const spawned: SlackSocketOpts[] = [];
  const spy = vi.fn<(opts: SlackSocketOpts) => SlackSocketHandle>((opts) => {
    spawned.push(opts);
    return { async stop() {} };
  });
  const killLast = (reason: string): void => {
    const last = spawned[spawned.length - 1];
    last?.onClosed?.(reason);
  };
  return { spy, spawned, killLast };
}

describe('slack manager — a dead socket is respawned', () => {
  it('respawns a socket that reported it closed for good', async () => {
    await seedSlackBinding({ botToken: 'xoxb-1', appToken: 'xapp-1' });
    const { spy, killLast } = makeFakeSockets();

    const manager = startSlackManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startSocket: spy,
    });
    await manager.refreshNow();
    expect(spy).toHaveBeenCalledTimes(1);

    // The websocket died (revoked token, Slack closed the session, …).
    killLast('invalid_auth');

    await manager.refreshNow();

    // Without the fix the manager sees an unchanged credential and does
    // nothing — the agent stays offline forever.
    expect(spy).toHaveBeenCalledTimes(2);
    expect(manager.activeCount()).toBe(1);
    // The respawn went through the normal read path, so it carries the
    // credential as stored NOW — Bolt's own reconnect re-dials with whatever
    // it captured at construction and would never pick up a rotation.
    expect(spy.mock.calls[1]?.[0]?.botToken).toBe('xoxb-1');
    await manager.stop();
  });

  it('does not respawn a socket that is still alive', async () => {
    await seedSlackBinding({ botToken: 'xoxb-1', appToken: 'xapp-1' });
    const { spy } = makeFakeSockets();

    const manager = startSlackManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startSocket: spy,
    });
    await manager.refreshNow();
    await manager.refreshNow();
    await manager.refreshNow();

    expect(spy).toHaveBeenCalledTimes(1);
    await manager.stop();
  });

  it('stops tracking a dead socket whose binding was removed in the meantime', async () => {
    await seedSlackBinding({ botToken: 'xoxb-1', appToken: 'xapp-1' });
    const { spy, killLast } = makeFakeSockets();

    const manager = startSlackManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startSocket: spy,
    });
    await manager.refreshNow();

    killLast('invalid_auth');
    await db.delete(channelBindings);
    await manager.refreshNow();

    // No resurrection of a binding the operator deleted.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(manager.activeCount()).toBe(0);
    await manager.stop();
  });
});

describe('slackReceiverOptions — we own the reconnect, not Bolt', () => {
  it('disables Bolt auto-reconnect', () => {
    // This single flag is what stops the unhandled rejection at its source:
    // with autoReconnectEnabled false, SocketModeClient neither calls
    // `delayReconnectAttempt(this.start)` on close (the un-caught promise) nor
    // swallows an unrecoverable error inside retrieveWSSURL — the failure
    // surfaces through the `start()` promise we already await and .catch().
    expect(slackReceiverOptions('xapp-token').autoReconnectEnabled).toBe(false);
  });

  it('passes the app token through', () => {
    expect(slackReceiverOptions('xapp-token').appToken).toBe('xapp-token');
  });
});
