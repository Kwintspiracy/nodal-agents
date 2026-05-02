// ports.test.ts — findFreePort returns a usable port

import { describe, it, expect } from 'vitest';
import { findFreePort, isPortBindable, DEFAULT_PORTS } from '../lib/ports.ts';
import { createServer } from 'net';

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
    // Block maxAttempts consecutive ports
    const servers: ReturnType<typeof createServer>[] = [];
    const base = 58000;
    const maxAttempts = 3;

    for (let i = 0; i < maxAttempts; i++) {
      const s = createServer();
      await new Promise<void>((resolve) => s.listen(base + i, '127.0.0.1', resolve));
      servers.push(s);
    }

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
