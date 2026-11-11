// wait-for-file.test.ts — l'attente d'un fichier dit son échec (#1042).
//
// Mutations vérifiées (chacune annulée ensuite) :
//   - le `throw` remplacé par `return waited` (l'ancienne boucle silencieuse) →
//     « a file that never comes… » et « a process that ends first… » rouges ;
//   - `ended` ignoré (attendre le délai entier) → « a process that ends first… »
//     rouge (il dure alors le délai, et non quelques ms) ;
//   - `explain` jamais appelé → « what the test knows… » rouge.

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForFile } from '../wait-for-file';

const dir = mkdtempSync(join(tmpdir(), 'nodal-waitfile-'));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));

describe('waitForFile', () => {
  it('returns the time waited once the file appears, even late', async () => {
    const file = join(dir, 'late.pid');
    setTimeout(() => writeFileSync(file, '42'), 300);
    const waited = await waitForFile(file, { timeoutMs: 5_000 });
    expect(waited).toBeGreaterThanOrEqual(250);
    expect(waited).toBeLessThan(5_000);
  });

  it('a file that already exists returns at once', async () => {
    const file = join(dir, 'there.pid');
    writeFileSync(file, '1');
    expect(await waitForFile(file, { timeoutMs: 5_000 })).toBeLessThan(100);
  });

  it('a file that never comes THROWS, naming the file, the time waited and the limit', async () => {
    const file = join(dir, 'never.pid');
    const began = Date.now();
    const err = await waitForFile(file, { timeoutMs: 400 }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).not.toBeNull();
    expect(err?.message).toContain(file);
    expect(err?.message).toMatch(/did not appear after \d+ ms/);
    expect(err?.message).toContain('the 400 ms limit passed');
    expect(Date.now() - began).toBeGreaterThanOrEqual(400);
  });

  it('a process that ends first stops the wait at once and is named, with what it ended with', async () => {
    const file = join(dir, 'never-written.pid');
    const began = Date.now();
    const ends = new Promise((r) => setTimeout(r, 150));
    const err = await waitForFile(file, { timeoutMs: 30_000, settled: ends }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toContain(file);
    expect(err?.message).toContain('the process that should write it ended first (resolved)');
    // Bien avant le délai : l'attente ne dépend d'aucune horloge une fois la cause connue.
    expect(Date.now() - began).toBeLessThan(5_000);
  });

  it('a process that rejects is named with its error', async () => {
    const file = join(dir, 'crashed.pid');
    const err = await waitForFile(file, {
      timeoutMs: 30_000,
      settled: Promise.reject(new Error('boom: exit 1')),
    }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toContain('ended first (rejected: boom: exit 1)');
  });

  it('what the test knows is appended to the error', async () => {
    const file = join(dir, 'explained.pid');
    const err = await waitForFile(file, {
      timeoutMs: 200,
      explain: async () => 'command 1 said: {"exit":1}',
    }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toContain('command 1 said: {"exit":1}');
  });

  it('a file written just as the process ends is a success, not a failure', async () => {
    const file = join(dir, 'just-in-time.pid');
    const ends = new Promise<void>((r) =>
      setTimeout(() => {
        writeFileSync(file, '7');
        r();
      }, 150),
    );
    await expect(waitForFile(file, { timeoutMs: 5_000, settled: ends })).resolves.toBeGreaterThan(
      0,
    );
  });
});
