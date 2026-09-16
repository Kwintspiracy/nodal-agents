// ports.test.ts — findFreePort returns a usable port

import { describe, it, expect } from 'vitest';
import { findFreePort, isPortBindable, DEFAULT_PORTS, formatPortRotation } from '../lib/ports.ts';
import { createServer } from 'net';
import { readFileSync } from 'node:fs';

/** Bind one port, resolving to false instead of throwing when the OS refuses. */
function tryListen(server: ReturnType<typeof createServer>, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    // `listen` reports refusal through the 'error' EVENT, never a throw. The
    // previous version of this helper passed only a success callback, so an
    // EACCES left the promise pending forever and the test died on a 5s
    // timeout with no indication of which port was refused.
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => resolve(true));
  });
}

/**
 * Occupy `count` CONSECUTIVE ports and return the base, scanning for a run the
 * OS will actually grant.
 *
 * The ports cannot be hardcoded. Windows reserves dynamic ranges for Hyper-V,
 * WSL and Docker, so binding a fixed base is a coin flip that depends on the
 * machine: 58000-58002 worked in CI and on most laptops, and failed on the
 * development machine because 58001 was reserved — a red test that said
 * nothing about the code under test.
 */
async function blockConsecutivePorts(
  count: number,
): Promise<{ base: number; servers: ReturnType<typeof createServer>[] }> {
  for (let base = 58000; base < 62000; base += count) {
    const servers: ReturnType<typeof createServer>[] = [];
    let ok = true;
    for (let i = 0; i < count; i++) {
      const s = createServer();
      if (await tryListen(s, base + i)) servers.push(s);
      else {
        ok = false;
        break;
      }
    }
    if (ok) return { base, servers };
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  }
  throw new Error(`No run of ${count} consecutive bindable ports found`);
}

describe('findFreePort', () => {
  it('returns a number in the valid port range', async () => {
    const port = await findFreePort(40000);
    expect(port).toBeGreaterThanOrEqual(1024);
    expect(port).toBeLessThanOrEqual(65535);
  });

  it('returns a port that can actually be bound', async () => {
    const port = await findFreePort(40001);
    // Verify we can actually listen on the returned port
    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      server.listen(port, '127.0.0.1', () => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      server.on('error', reject);
    });
  });

  it('returns the preferred port if it is free', async () => {
    // Use a high port unlikely to be in use
    const preferred = 59876;
    const port = await findFreePort(preferred);
    // Should be preferred or higher (if preferred was taken)
    expect(port).toBeGreaterThanOrEqual(preferred);
  });

  it('skips ports that are in use', async () => {
    // Bind a port, then ask findFreePort to start from it
    const blocker = createServer();
    const blockedPort = await new Promise<number>((resolve, reject) => {
      blocker.listen(0, '127.0.0.1', () => {
        const addr = blocker.address();
        if (typeof addr === 'object' && addr) {
          resolve(addr.port);
        } else {
          reject(new Error('No address'));
        }
      });
    });

    try {
      const port = await findFreePort(blockedPort);
      // Should have skipped the blocked port
      expect(port).not.toBe(blockedPort);
      expect(port).toBeGreaterThan(blockedPort);
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });

  it('rejects after maxAttempts', async () => {
    const maxAttempts = 3;
    const { base, servers } = await blockConsecutivePorts(maxAttempts);

    try {
      await expect(findFreePort(base, maxAttempts)).rejects.toThrow('Could not find a free port');
    } finally {
      await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    }
  });
});

describe('isPortBindable', () => {
  it('returns true for a port that nothing is holding', async () => {
    const port = await findFreePort(60100);
    await expect(isPortBindable(port)).resolves.toBe(true);
  });

  it('returns false when the port is already in use', async () => {
    const blocker = createServer();
    const blockedPort = await new Promise<number>((resolve, reject) => {
      blocker.listen(0, '127.0.0.1', () => {
        const addr = blocker.address();
        if (typeof addr === 'object' && addr) resolve(addr.port);
        else reject(new Error('No address'));
      });
    });

    try {
      await expect(isPortBindable(blockedPort)).resolves.toBe(false);
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });

  it('returns false for an out-of-range port (negative)', async () => {
    // Out-of-range integers raise on listen(); the helper resolves to false.
    await expect(isPortBindable(-1)).resolves.toBe(false);
  });

  it('does not throw — always resolves boolean', async () => {
    // Whatever the kernel says, the helper must not reject.
    const result = await isPortBindable(0).catch(() => 'rejected');
    expect(typeof result).toBe('boolean');
  });
});

describe('DEFAULT_PORTS', () => {
  it('has the expected default values', () => {
    expect(DEFAULT_PORTS.web).toBe(3000);
    expect(DEFAULT_PORTS.runner).toBe(3001);
    expect(DEFAULT_PORTS.postgres).toBe(25432);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('formatPortRotation @cap:installer-et-demarrer/moteur', () => {
  // Review pass 3 of #114. After a hard Ctrl+C on a machine whose process table
  // will not answer, a recorded child can still hold :3000. Every path refuses
  // it — nothing is killed on an unconfirmed identity — and `up` rotates around
  // it. The stack comes back on :3001 and that worker is still there, holding
  // the old port, and nobody was ever told.
  it('names the pid left running and says the port was abandoned, not freed', () => {
    const lines = formatPortRotation([{ name: 'web', from: 3000, to: 3001, heldBy: 4242 }]);
    const text = lines.join(' ');
    expect(text).toContain('web: 3000 → 3001');
    expect(text).toContain('pid 4242');
    expect(text).toContain('abandoned, not freed');
    expect(text).toMatch(/was not stopped/);
  });

  it('says nothing about a holder when no pid was measured', () => {
    // A Windows reservation, or a ghost socket bound to a dead pid: the port is
    // unbindable and there is nobody to name. Inventing one here is the mistake
    // #97 made thirteen times in one incident report.
    const lines = formatPortRotation([{ name: 'postgres', from: 25432, to: 25433, heldBy: null }]);
    expect(lines).toEqual(['  - postgres: 25432 → 25433']);
  });

  it('is what `up` prints when it rotates, with the holder actually measured', () => {
    // Read from source: the rotation block runs inside `runUp`, which cannot be
    // driven here without a real config and real ports. What IS checkable is
    // that `up` asks who holds the old port and hands the answer to this
    // formatter — remove either and this goes red.
    const up = readFileSync(new URL('../commands/up.ts', import.meta.url), 'utf-8');
    const block = up.slice(up.indexOf('const portChanges'), up.indexOf('writeConfig(config)'));
    expect(block).toContain('heldBy: await pidListeningOnPort(configured)');
    expect(block).toContain('formatPortRotation(portChanges)');
  });

  it('reports each rotated port on its own', () => {
    const lines = formatPortRotation([
      { name: 'web', from: 3000, to: 3001, heldBy: 11 },
      { name: 'runner', from: 3001, to: 3002, heldBy: null },
    ]);
    expect(lines.filter((l) => l.includes('→'))).toHaveLength(2);
    expect(lines.filter((l) => l.includes('STILL HELD'))).toHaveLength(1);
  });
});
