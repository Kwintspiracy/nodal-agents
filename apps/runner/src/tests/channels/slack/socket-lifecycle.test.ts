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
  // Each fake carries its own liveness so tests can assert the STATE of the
  // connection rather than how many times the factory was called (invariant
  // #5 — a call count would pass even if the live socket had been torn down).
  const live: Array<{ agentId: string; stopped: boolean }> = [];
  const spy = vi.fn<(opts: SlackSocketOpts) => SlackSocketHandle>((opts) => {
    spawned.push(opts);
    const state = { agentId: opts.agentId, stopped: false };
    live.push(state);
    return {
      async stop() {
        state.stopped = true;
      },
    };
  });
  const killLast = (reason: string): void => {
    const last = spawned[spawned.length - 1];
    last?.onClosed?.(reason);
  };
  const connectLast = (): void => {
    const last = spawned[spawned.length - 1];
    last?.onConnected?.();
  };
  return { spy, spawned, live, killLast, connectLast };
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

  it('leaves a HEALTHY socket connected across refreshes', async () => {
    await seedSlackBinding({ botToken: 'xoxb-1', appToken: 'xapp-1' });
    const { spy, live, connectLast } = makeFakeSockets();

    const manager = startSlackManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startSocket: spy,
    });
    await manager.refreshNow();
    connectLast();
    await manager.refreshNow();
    await manager.refreshNow();

    // The assertion is on the socket's STATE, not the factory's call count:
    // the connection opened first is still the live one, and was never torn
    // down and rebuilt behind the scenes.
    expect(live).toHaveLength(1);
    expect(live[0]?.stopped).toBe(false);
    expect(manager.activeCount()).toBe(1);
    await manager.stop();
    // …and a deliberate shutdown DOES stop it, so `stopped` is a real signal
    // rather than a field nothing ever writes.
    expect(live[0]?.stopped).toBe(true);
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

describe('a permanently invalid credential must not become a new log storm', () => {
  // Found by codex review on PR #42, against the fix in that same PR: making a
  // dead socket respawn means a token that is invalid FOREVER gets retried on
  // every 30s refresh, each attempt writing "start failed" + "socket closed"
  // and calling Slack again. That trades one log storm for another — and adds
  // an unbounded API call rate against a bot that will never authenticate.
  //
  // The retry therefore backs off: after each consecutive failure the manager
  // waits an increasing number of refreshes before trying again, and the
  // counter resets the moment a socket actually connects (or the credential
  // changes, which respawns through the fingerprint path regardless).
  it('backs off instead of retrying every refresh', async () => {
    await seedSlackBinding({ botToken: 'xoxb-bad', appToken: 'xapp-bad' });
    const { spy, killLast } = makeFakeSockets();

    const manager = startSlackManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startSocket: spy,
    });

    // 20 refreshes, the socket dying immediately every time.
    for (let i = 0; i < 20; i++) {
      await manager.refreshNow();
      killLast('start failed');
    }

    // Without backoff this is 20 spawns (and 20 calls to Slack). With it, a
    // handful — but never zero after the first, or a token fixed later would
    // never be picked up.
    expect(spy.mock.calls.length).toBeLessThanOrEqual(6);
    expect(spy.mock.calls.length).toBeGreaterThan(1);
    await manager.stop();
  });

  it('resets the backoff once a socket actually connects', async () => {
    await seedSlackBinding({ botToken: 'xoxb-1', appToken: 'xapp-1' });
    const { spy, killLast, connectLast } = makeFakeSockets();

    const manager = startSlackManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startSocket: spy,
    });

    // Three failures in a row build up a wait…
    for (let i = 0; i < 3; i++) {
      await manager.refreshNow();
      killLast('start failed');
    }
    // …then Slack comes back: this attempt connects.
    let spawnsBefore = spy.mock.calls.length;
    for (let i = 0; i < 10 && spy.mock.calls.length === spawnsBefore; i++) {
      await manager.refreshNow();
    }
    connectLast();

    // A later, unrelated drop must be retried IMMEDIATELY — the earlier
    // failures are history, not a permanent penalty on this binding.
    killLast('disconnected');
    spawnsBefore = spy.mock.calls.length;
    await manager.refreshNow();

    expect(spy.mock.calls.length).toBe(spawnsBefore + 1);
    await manager.stop();
  });

  it('collapses the repeated failure logs instead of one pair per attempt', async () => {
    await seedSlackBinding({ botToken: 'xoxb-bad', appToken: 'xapp-bad' });
    const { spy, killLast } = makeFakeSockets();
    const warns: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      warns.push(a.map(String).join(' '));
    });

    const manager = startSlackManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startSocket: spy,
    });
    for (let i = 0; i < 40; i++) {
      await manager.refreshNow();
      killLast('start failed');
    }

    const deathLines = warns.filter(
      (w) => w.includes('slack-manager') && w.includes('start failed'),
    );
    expect(deathLines.length).toBeLessThanOrEqual(3);
    // The first one is always there: a broken binding is never silent.
    expect(deathLines.length).toBeGreaterThan(0);
    await manager.stop();
  });
});
