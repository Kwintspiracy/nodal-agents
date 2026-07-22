// manager.test.ts — startWhatsAppManager spawns one Baileys socket per
// enabled whatsapp binding, respawns on credential (sessionDir) rotation,
// despawns on disable/removal, and tracks pairing state (qr/status) per
// agent. Fake ensureSocket/closeSocket are injected so no real Baileys
// websocket is ever created — only the DB-scan/diff logic and the
// event→pairing-map wiring are exercised.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { channelBindings, agents } from '@nodal-agents/db';
import type { WhatsAppHandle, WhatsAppStatus } from '@nodal-agents/delivery';
import { startWhatsAppManager } from '../../../channels/whatsapp/manager.ts';
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

/** A fake Baileys handle — a real EventEmitter (cast to the typed shape) so
 *  the manager's own `.on('qr'|'status'|'message', ...)` wiring is exercised
 *  exactly like against the real socket-manager, with zero network. */
interface FakeHandle {
  handle: WhatsAppHandle;
  emitQr(qr: string): void;
  emitStatus(status: WhatsAppStatus): void;
  emitMessage(message: unknown): void;
}

function makeFakeHandle(sessionDir: string): FakeHandle {
  const events = new EventEmitter();
  let status: WhatsAppStatus = 'connecting';
  const handle: WhatsAppHandle = {
    bindingKey: sessionDir,
    events: events as unknown as WhatsAppHandle['events'],
    getStatus: () => status,
    getIdentity: () => null,
    send: vi.fn(async () => 'msg-id'),
    listGroups: vi.fn(async () => []),
  };
  return {
    handle,
    emitQr: (qr) => {
      status = 'qr_pending';
      events.emit('qr', qr);
    },
    emitStatus: (s) => {
      status = s;
      events.emit('status', s);
    },
    emitMessage: (message) => events.emit('message', message),
  };
}

/** ensureSocket/closeSocket fakes — one FakeHandle per sessionDir (bindingKey),
 *  reused across calls exactly like the real ensureWhatsAppSocket registry. */
function makeFakeFactory() {
  const bySessionDir = new Map<string, FakeHandle>();
  const closed: string[] = [];
  const ensureSocket = vi.fn((sessionDir: string) => {
    let fake = bySessionDir.get(sessionDir);
    if (!fake) {
      fake = makeFakeHandle(sessionDir);
      bySessionDir.set(sessionDir, fake);
    }
    return fake.handle;
  });
  const closeSocket = vi.fn((sessionDir: string) => {
    closed.push(sessionDir);
    bySessionDir.delete(sessionDir);
  });
  return { ensureSocket, closeSocket, bySessionDir, closed };
}

let db: TestDb;
let seed: { entityId: string; agentId: string };

beforeEach(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
});

describe('startWhatsAppManager — spawn/despawn/rotation', () => {
  it('starts with zero sockets when no binding exists', async () => {
    const { ensureSocket } = makeFakeFactory();
    const manager = startWhatsAppManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      ensureSocket,
    });
    await manager.refreshNow();
    expect(manager.activeCount()).toBe(0);
    expect(ensureSocket).not.toHaveBeenCalled();
    await manager.stop();
  });

  it('spawns a socket for each enabled whatsapp binding on an active agent', async () => {
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'whatsapp',
      credentials: JSON.stringify({ sessionDir: '/sessions/agent-1' }),
      enabled: true,
    });

    const { ensureSocket } = makeFakeFactory();
    const manager = startWhatsAppManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      ensureSocket,
    });
    await manager.refreshNow();
    expect(manager.activeCount()).toBe(1);
    expect(ensureSocket).toHaveBeenCalledWith('/sessions/agent-1', {
      sessionDir: '/sessions/agent-1',
    });
    await manager.stop();
    expect(manager.activeCount()).toBe(0);
  });

  it('ignores a DISABLED binding', async () => {
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'whatsapp',
      credentials: JSON.stringify({ sessionDir: '/sessions/agent-1' }),
      enabled: false,
    });

    const { ensureSocket } = makeFakeFactory();
    const manager = startWhatsAppManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      ensureSocket,
    });
    await manager.refreshNow();
    expect(manager.activeCount()).toBe(0);
    await manager.stop();
  });

  it('ignores a binding on an INACTIVE agent', async () => {
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'whatsapp',
      credentials: JSON.stringify({ sessionDir: '/sessions/agent-1' }),
      enabled: true,
    });
    await db.update(agents).set({ active: false }).where(eq(agents.id, seed.agentId));

    const { ensureSocket } = makeFakeFactory();
    const manager = startWhatsAppManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      ensureSocket,
    });
    await manager.refreshNow();
    expect(manager.activeCount()).toBe(0);
    await manager.stop();
  });

  it('despawns a socket when its binding is disabled after the fact', async () => {
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'whatsapp',
      credentials: JSON.stringify({ sessionDir: '/sessions/agent-1' }),
      enabled: true,
    });

    const { ensureSocket, closeSocket, closed } = makeFakeFactory();
    const manager = startWhatsAppManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      ensureSocket,
      closeSocket,
    });
    await manager.refreshNow();
    expect(manager.activeCount()).toBe(1);

    await db
      .update(channelBindings)
      .set({ enabled: false })
      .where(eq(channelBindings.agentId, seed.agentId));

    await manager.refreshNow();
    expect(manager.activeCount()).toBe(0);
    expect(closed).toContain('/sessions/agent-1');
    await manager.stop();
  });

  it('respawns (close old, open new) when the sessionDir credential rotates', async () => {
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'whatsapp',
      credentials: JSON.stringify({ sessionDir: '/sessions/old' }),
      enabled: true,
    });

    const { ensureSocket, closeSocket, closed } = makeFakeFactory();
    const manager = startWhatsAppManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      ensureSocket,
      closeSocket,
    });
    await manager.refreshNow();
    expect(ensureSocket).toHaveBeenCalledTimes(1);

    await db
      .update(channelBindings)
      .set({ credentials: JSON.stringify({ sessionDir: '/sessions/new' }) })
      .where(eq(channelBindings.agentId, seed.agentId));

    await manager.refreshNow();
    expect(manager.activeCount()).toBe(1);
    expect(closed).toContain('/sessions/old');
    expect(ensureSocket).toHaveBeenCalledWith('/sessions/new', { sessionDir: '/sessions/new' });

    await manager.stop();
  });

  it('skips a binding with no usable sessionDir credential', async () => {
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'whatsapp',
      credentials: JSON.stringify({ somethingElse: 'x' }),
      enabled: true,
    });

    const { ensureSocket } = makeFakeFactory();
    const manager = startWhatsAppManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      ensureSocket,
    });
    await manager.refreshNow();
    expect(manager.activeCount()).toBe(0);
    expect(ensureSocket).not.toHaveBeenCalled();
    await manager.stop();
  });

  it('one binding whose spawn throws does not abort the refresh for other bindings', async () => {
    const [agent2] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'Second WA Agent',
        slug: `wa-agent-2-${Date.now()}`,
        personality: 'test',
      })
      .returning();

    await db.insert(channelBindings).values([
      {
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'whatsapp',
        credentials: JSON.stringify({ sessionDir: '/sessions/throws' }),
        enabled: true,
      },
      {
        entityId: seed.entityId,
        agentId: agent2!.id,
        channel: 'whatsapp',
        credentials: JSON.stringify({ sessionDir: '/sessions/ok' }),
        enabled: true,
      },
    ]);

    const ensureSocket = vi.fn((sessionDir: string) => {
      if (sessionDir === '/sessions/throws') throw new Error('boom: corrupted binding');
      return makeFakeHandle(sessionDir).handle;
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const manager = startWhatsAppManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      ensureSocket,
    });
    await manager.refreshNow();

    // The failing binding never got an active socket; the healthy one did.
    expect(manager.activeCount()).toBe(1);
    expect(ensureSocket).toHaveBeenCalledWith('/sessions/ok', { sessionDir: '/sessions/ok' });
    expect(
      consoleErrorSpy.mock.calls.some(
        ([msg]) =>
          typeof msg === 'string' &&
          msg.includes('[whatsapp-manager') &&
          msg.includes('boom: corrupted binding'),
      ),
    ).toBe(true);

    consoleErrorSpy.mockRestore();
    await manager.stop();
  });
});

describe('startWhatsAppManager — pairing state lifecycle', () => {
  it('has no pairing state before a binding is spawned', async () => {
    const { ensureSocket } = makeFakeFactory();
    const manager = startWhatsAppManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      ensureSocket,
    });
    expect(manager.getPairingState(seed.agentId)).toBeNull();
    await manager.stop();
  });

  it('populates {status: qr_pending, qr} on a qr event, then clears qr on open', async () => {
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'whatsapp',
      credentials: JSON.stringify({ sessionDir: '/sessions/pairing-1' }),
      enabled: true,
    });

    const { ensureSocket, bySessionDir } = makeFakeFactory();
    const manager = startWhatsAppManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      ensureSocket,
    });
    await manager.refreshNow();

    const fake = bySessionDir.get('/sessions/pairing-1')!;
    fake.emitQr('QR_PAYLOAD_1');
    expect(manager.getPairingState(seed.agentId)).toEqual({
      status: 'qr_pending',
      qr: 'QR_PAYLOAD_1',
    });

    fake.emitStatus('open');
    expect(manager.getPairingState(seed.agentId)).toEqual({ status: 'open', qr: null });

    await manager.stop();
  });

  it('clears pairing state when the binding despawns', async () => {
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'whatsapp',
      credentials: JSON.stringify({ sessionDir: '/sessions/pairing-2' }),
      enabled: true,
    });

    const { ensureSocket, closeSocket } = makeFakeFactory();
    const manager = startWhatsAppManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      ensureSocket,
      closeSocket,
    });
    await manager.refreshNow();
    expect(manager.getPairingState(seed.agentId)).not.toBeNull();

    await db
      .update(channelBindings)
      .set({ enabled: false })
      .where(eq(channelBindings.agentId, seed.agentId));
    await manager.refreshNow();

    expect(manager.getPairingState(seed.agentId)).toBeNull();
    await manager.stop();
  });
});

describe('startWhatsAppManager — ensurePairingStarted', () => {
  it('is idempotent: returns "started" without a second ensureSocket call when already active', async () => {
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'whatsapp',
      credentials: JSON.stringify({ sessionDir: '/sessions/idem-1' }),
      enabled: true,
    });

    const { ensureSocket } = makeFakeFactory();
    const manager = startWhatsAppManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      ensureSocket,
    });
    await manager.refreshNow();
    expect(ensureSocket).toHaveBeenCalledTimes(1);

    const result = await manager.ensurePairingStarted(seed.agentId);
    expect(result).toBe('started');
    expect(ensureSocket).toHaveBeenCalledTimes(1); // no extra spawn

    await manager.stop();
  });

  it('spawns immediately (without waiting for the poll tick) for a not-yet-active binding', async () => {
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'whatsapp',
      credentials: JSON.stringify({ sessionDir: '/sessions/idem-2' }),
      enabled: true,
    });

    const { ensureSocket } = makeFakeFactory();
    const manager = startWhatsAppManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999, // the poll tick would never fire in this test
      ensureSocket,
    });

    const result = await manager.ensurePairingStarted(seed.agentId);
    expect(result).toBe('started');
    expect(manager.activeCount()).toBe(1);

    await manager.stop();
  });

  it('returns "no_binding" for an agent with no whatsapp binding', async () => {
    const { ensureSocket } = makeFakeFactory();
    const manager = startWhatsAppManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      ensureSocket,
    });

    const result = await manager.ensurePairingStarted(seed.agentId);
    expect(result).toBe('no_binding');
    expect(ensureSocket).not.toHaveBeenCalled();

    await manager.stop();
  });

  it('returns "no_binding" for a DISABLED binding', async () => {
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'whatsapp',
      credentials: JSON.stringify({ sessionDir: '/sessions/idem-3' }),
      enabled: false,
    });

    const { ensureSocket } = makeFakeFactory();
    const manager = startWhatsAppManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
      ensureSocket,
    });

    const result = await manager.ensurePairingStarted(seed.agentId);
    expect(result).toBe('no_binding');

    await manager.stop();
  });

  it('does not double-spawn (single ensureSocket call, single listener set) when a refresh() tick races ensurePairingStarted for the same agent', async () => {
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'whatsapp',
      credentials: JSON.stringify({ sessionDir: '/sessions/race-1' }),
      enabled: true,
    });

    const { ensureSocket, bySessionDir } = makeFakeFactory();
    const manager = startWhatsAppManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999, // no timer-driven tick — only the two racing calls below
      ensureSocket,
    });

    // ensurePairingStarted awaits getChannelBinding, then an agents SELECT,
    // re-checking `active.has` after each — a concurrent refreshNow() tick
    // can spawn the same agent's socket while those awaits are in flight.
    // Without the re-checks this races into TWO spawnOne calls for one
    // binding: two listener sets on the SAME shared Baileys handle, so every
    // inbound message would fire two jobs.
    await Promise.all([manager.ensurePairingStarted(seed.agentId), manager.refreshNow()]);

    expect(manager.activeCount()).toBe(1);
    expect(ensureSocket).toHaveBeenCalledTimes(1);
    const fake = bySessionDir.get('/sessions/race-1')!;
    expect(fake.handle.events.listenerCount('message')).toBe(1);
    expect(fake.handle.events.listenerCount('qr')).toBe(1);
    expect(fake.handle.events.listenerCount('status')).toBe(1);

    await manager.stop();
  });
});
