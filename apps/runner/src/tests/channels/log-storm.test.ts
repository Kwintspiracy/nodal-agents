// log-storm.test.ts — a database outage must not destroy the log.
//
// End-to-end assertion of the point of lib/repeat-log.ts, wired through the
// real managers rather than the helper in isolation: with Postgres gone, the
// number of lines a manager writes has to stop growing linearly with time.
//
// Measured before this change on a real install: 7 412 identical lines out of
// 61 359 (12%), running to the last line of the file. Service logs rotate at
// 20 MB, so a long outage evicts the earlier lines — the ones that said WHY
// the database went away — and keeps only the consequence, repeated. The log
// that would have explained the incident is destroyed by the incident.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startSlackManager } from '../../channels/slack/manager.ts';
import { startDiscordManager } from '../../channels/discord/manager.ts';
import { _resetRepeatLogForTests } from '../../lib/repeat-log.ts';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';

const testEnv = { WORKER_SECRET: 's', APP_URL: 'http://localhost:3099' } as unknown as RunnerEnv;

/** A db whose every query rejects — what the managers see when Postgres is gone. */
function makeDeadDb(): RunnerDeps['db'] {
  const fail = () => Promise.reject(new Error('connection refused'));
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: fail,
    limit: fail,
    then: (_res: unknown, rej: (e: unknown) => void) => rej(new Error('connection refused')),
  };
  return { select: () => chain } as unknown as RunnerDeps['db'];
}

function makeDeps(db: RunnerDeps['db']): RunnerDeps {
  return {
    db,
    llmClient: {} as RunnerDeps['llmClient'],
    embeddingClient: {} as RunnerDeps['embeddingClient'],
    registry: {} as RunnerDeps['registry'],
    authProvider: {} as RunnerDeps['authProvider'],
    close: async () => {},
  };
}

let warns: string[];

beforeEach(() => {
  _resetRepeatLogForTests();
  warns = [];
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
    warns.push(a.map(String).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a manager facing a dead database', () => {
  it('logs the first failure, then collapses 60 more into a handful of lines', async () => {
    const manager = startSlackManager(makeDeps(makeDeadDb()), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startSocket: () => ({ async stop() {} }),
    });

    // 60 ticks ≈ 30 minutes of outage at the real 30s interval.
    for (let i = 0; i < 60; i++) await manager.refreshNow();

    const scanLines = warns.filter((w) => w.includes('DB scan failed'));
    // Before: 60 lines — one per tick, per manager, forever.
    expect(scanLines.length).toBeLessThanOrEqual(4);
    // But never zero: the first failure is always visible (invariant #4).
    expect(scanLines.length).toBeGreaterThan(0);
    expect(scanLines[0]).toContain('connection refused');
    await manager.stop();
  });

  it('never hides HOW MANY failures happened', async () => {
    const manager = startSlackManager(makeDeps(makeDeadDb()), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startSocket: () => ({ async stop() {} }),
    });

    for (let i = 0; i < 40; i++) await manager.refreshNow();

    // A reader must be able to size the outage from the log alone.
    expect(warns.join('\n')).toContain('40 in total');
    await manager.stop();
  });

  it('keeps each manager independent — slack failing never mutes discord', async () => {
    const deadDb = makeDeadDb();
    const slack = startSlackManager(makeDeps(deadDb), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startSocket: () => ({ async stop() {} }),
    });
    for (let i = 0; i < 30; i++) await slack.refreshNow();

    const discord = startDiscordManager(makeDeps(deadDb), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      startGateway: () => ({ async stop() {} }),
    });
    await discord.refreshNow();

    // Discord's FIRST failure is logged in full even though slack has been
    // failing for 30 ticks — suppression is per site, never global.
    expect(warns.filter((w) => w.includes('[discord-manager] DB scan failed'))).toHaveLength(1);
    await slack.stop();
    await discord.stop();
  });
});
