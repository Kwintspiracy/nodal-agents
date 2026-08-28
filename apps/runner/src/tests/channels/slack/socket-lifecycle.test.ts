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

  it('clears the backoff once a socket SURVIVES a full refresh cycle', async () => {
    await seedSlackBinding({ botToken: 'xoxb-1', appToken: 'xapp-1' });
    const { spy, killLast, connectLast } = makeFakeSockets();

    const manager = startSlackManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startSocket: spy,
    });

    // Three failed starts in a row build up a wait.
    for (let i = 0; i < 3; i++) {
      await manager.refreshNow();
      killLast('start failed: invalid_auth');
    }

    // Slack comes back. Surviving a whole refresh — not merely having
    // connected once — is what clears the penalty: a socket that connects and
    // dies immediately, repeatedly, must keep backing off (see the flapping
    // case below), so `onConnected` alone deliberately does NOT reset it.
    let spawnsBefore = spy.mock.calls.length;
    for (let i = 0; i < 40 && spy.mock.calls.length === spawnsBefore; i++) {
      await manager.refreshNow();
    }
    connectLast();
    await manager.refreshNow();

    // A later, unrelated drop is now retried at once — the earlier failures
    // are history, not a permanent penalty on this binding.
    spawnsBefore = spy.mock.calls.length;
    killLast('disconnected');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

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

describe('an ESTABLISHED socket comes back at once, not on the next scan', () => {
  // Found by codex review on PR #42, 3rd pass. Slack rotates connections on
  // its own (`refresh_requested`) — routine, frequent, and harmless while Bolt
  // reconnected itself. With Bolt's auto-reconnect off, every one of those
  // became terminal, and the replacement waited for the next 30s scan: a
  // recurring ingress gap where messages are missed, caused by the fix rather
  // than by any fault. A socket that HAD connected therefore triggers an
  // immediate managed refresh; the backoff still governs sockets that never
  // connected at all.
  const settle = async (): Promise<void> => {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };

  it('respawns without waiting for a refresh call', async () => {
    await seedSlackBinding({ botToken: 'xoxb-1', appToken: 'xapp-1' });
    const { spy, killLast, connectLast } = makeFakeSockets();

    const manager = startSlackManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startSocket: spy,
    });
    await manager.refreshNow();
    connectLast();
    expect(spy).toHaveBeenCalledTimes(1);

    // Slack rotates the connection. NOTE: no refreshNow() below — that is the
    // whole point.
    killLast('disconnected');
    await settle();

    expect(spy).toHaveBeenCalledTimes(2);
    await manager.stop();
  });

  it('does NOT trigger its own immediate respawn when the socket never connected', async () => {
    await seedSlackBinding({ botToken: 'xoxb-bad', appToken: 'xapp-bad' });
    const { spy, killLast } = makeFakeSockets();

    const manager = startSlackManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startSocket: spy,
    });
    // Drain the constructor's own tick first: with a scan still in flight, the
    // queued-refresh path would run another scan and pick the dead socket up
    // legitimately, which is not what this test is about.
    await manager.refreshNow();
    await settle();
    const spawnsBefore = spy.mock.calls.length;

    // A failed start must not, by itself, kick off a new scan — retrying an
    // invalid token the instant it fails is how this becomes an unbounded call
    // rate against Slack. It is still retried later, on the backoff schedule
    // (see the backoff cases above).
    killLast('start failed: invalid_auth');
    await settle();

    expect(spy.mock.calls.length).toBe(spawnsBefore);
    await manager.stop();
  });

  it('stops the dead socket before replacing it', async () => {
    await seedSlackBinding({ botToken: 'xoxb-1', appToken: 'xapp-1' });
    const { spy, live, killLast, connectLast } = makeFakeSockets();

    const manager = startSlackManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startSocket: spy,
    });
    await manager.refreshNow();
    connectLast();

    // A transport error reports closure while the old client's close
    // handshake and timers may still be running. Dropping the handle without
    // stopping it leaves that client alive AND unreachable — the manager's own
    // shutdown can never stop it, and two clients can briefly coexist on one
    // binding (duplicate inbound events).
    killLast('transport error: socket hang up');
    await settle();

    expect(live).toHaveLength(2);
    expect(live[0]?.stopped).toBe(true);
    expect(live[1]?.stopped).toBe(false);
    await manager.stop();
  });

  it('a socket that dies right after connecting, over and over, still backs off', async () => {
    await seedSlackBinding({ botToken: 'xoxb-flappy', appToken: 'xapp-1' });
    const { spy, killLast, connectLast } = makeFakeSockets();

    const manager = startSlackManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startSocket: spy,
    });
    await manager.refreshNow();

    // 15 connect-then-die cycles. Immediate respawn must not turn a flapping
    // connection into a hot loop: only a socket that SURVIVES a full refresh
    // cycle counts as healthy enough to clear the backoff.
    for (let i = 0; i < 15; i++) {
      connectLast();
      killLast('disconnected');
      await settle();
    }

    expect(spy.mock.calls.length).toBeLessThanOrEqual(8);
    await manager.stop();
  });
});

describe('retry state does not outlive its binding', () => {
  // Found by codex review on PR #42, 4th pass. A despawned binding left its
  // entry in the retry map: reconfigure that agent later — with a brand new
  // token — and its first failure inherits the old penalty, waiting up to 31
  // refreshes (~16 minutes) before a second attempt. Deleted agents also left
  // the map growing without bound.
  it('a reconfigured binding starts from a clean backoff', async () => {
    await seedSlackBinding({ botToken: 'xoxb-bad', appToken: 'xapp-bad' });
    const { spy, killLast } = makeFakeSockets();

    const manager = startSlackManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startSocket: spy,
    });

    // Fail enough times to earn the longest wait (31 refreshes).
    for (let i = 0; i < 40; i++) {
      await manager.refreshNow();
      killLast('start failed: invalid_auth');
    }

    // The operator removes the binding entirely…
    await db.delete(channelBindings);
    await manager.refreshNow();
    expect(manager.activeCount()).toBe(0);

    // …then configures it again with a working token. The first spawn happens
    // regardless (nothing is in `active`), so the inherited penalty only shows
    // on the NEXT failure — which is exactly where a stale entry would hurt:
    // the fresh binding would sit out the dead one's 31-refresh wait.
    await seedSlackBinding({ botToken: 'xoxb-fresh', appToken: 'xapp-fresh' });
    await manager.refreshNow();
    killLast('start failed: transient');

    const spawnsBefore = spy.mock.calls.length;
    // A clean binding retries on its very next refresh (backoff[1] === 0).
    await manager.refreshNow();

    expect(spy.mock.calls.length).toBe(spawnsBefore + 1);
    expect(spy.mock.calls[spy.mock.calls.length - 1]?.[0]?.botToken).toBe('xoxb-fresh');
    await manager.stop();
  });
});

describe('a death DURING an in-flight scan is not lost', () => {
  // Found by codex review on PR #42, 5th pass. `refresh()` is single-flight:
  // called while a scan is already running it just returns that scan's
  // promise. If an established socket dies AFTER its own row has been
  // processed by that in-flight scan, the immediate-respawn call collapses
  // into it and nothing else is queued — the dead socket then sits registered
  // until the 30s timer, missing messages, despite the promise of an immediate
  // respawn. The manager must remember that a refresh was asked for and run
  // one more after the current scan settles.
  it('runs another scan after the current one when a socket dies mid-scan', async () => {
    await seedSlackBinding({ botToken: 'xoxb-1', appToken: 'xapp-1' });

    const spawned: SlackSocketOpts[] = [];
    let killDuringSpawn = false;
    const spy = vi.fn<(opts: SlackSocketOpts) => SlackSocketHandle>((opts) => {
      spawned.push(opts);
      opts.onConnected?.();
      if (killDuringSpawn) {
        killDuringSpawn = false;
        // Dies while refreshInternal is still running, one await after its own
        // row was handled — exactly the window the single-flight guard hides.
        opts.onClosed?.('disconnected');
      }
      return { async stop() {} };
    });

    const manager = startSlackManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startSocket: spy,
    });

    killDuringSpawn = true;
    await manager.refreshNow();
    // Let any queued follow-up scan run.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

    // Two spawns: the original, and the replacement for the one that died
    // inside the scan. With the race, this stays at 1 until the 30s timer.
    expect(spy).toHaveBeenCalledTimes(2);
    await manager.stop();
  });
});
