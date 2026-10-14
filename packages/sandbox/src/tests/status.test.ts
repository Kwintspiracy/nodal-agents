// status.test.ts — le statut du bac à sable : sondé une fois, journalisé une
// fois, toujours avec un code et une raison quand il manque.

import { describe, it, expect } from 'vitest';
import { createSandbox, getSandboxStatus } from '../status';
import type { SandboxBackend } from '../types';

describe('createSandbox', () => {
  it('sans backend pour le système : indisponible, SANDBOX_NOT_IMPLEMENTED, la plateforme dans la raison', async () => {
    const logged: { code: string; fields: Record<string, unknown> }[] = [];
    const sandbox = createSandbox(null, {
      platform: 'darwin',
      log: (code, fields) => logged.push({ code, fields }),
    });
    expect(await sandbox.status()).toEqual({
      state: 'unavailable',
      code: 'SANDBOX_NOT_IMPLEMENTED',
      reason: 'no sandbox backend for platform darwin yet',
    });
    await sandbox.status();
    expect(logged).toEqual([
      {
        code: 'SANDBOX_UNAVAILABLE',
        fields: {
          code: 'SANDBOX_NOT_IMPLEMENTED',
          reason: 'no sandbox backend for platform darwin yet',
          platform: 'darwin',
        },
      },
    ]);
  });

  it('un backend est sondé UNE fois, même sous des appels concurrents', async () => {
    let probes = 0;
    const backend: SandboxBackend = {
      probe: async () => {
        probes++;
        await new Promise((r) => setTimeout(r, 20));
        return { state: 'available', backend: 'fake' };
      },
      start: async () => {
        throw new Error('not used');
      },
    };
    const codes: string[] = [];
    const sandbox = createSandbox(backend, { log: (code) => codes.push(code) });
    const all = await Promise.all([sandbox.status(), sandbox.status(), sandbox.status()]);
    expect(all).toEqual([
      { state: 'available', backend: 'fake' },
      { state: 'available', backend: 'fake' },
      { state: 'available', backend: 'fake' },
    ]);
    expect(probes).toBe(1);
    expect(codes).toEqual(['SANDBOX_ACTIVE']);
  });
});

describe('getSandboxStatus — le statut de CE processus', () => {
  it.runIf(process.platform !== 'win32')(
    'macOS / Linux : indisponible tant que leur backend n’existe pas, et la raison le dit',
    async () => {
      expect(await getSandboxStatus()).toEqual({
        state: 'unavailable',
        code: 'SANDBOX_NOT_IMPLEMENTED',
        reason: `no sandbox backend for platform ${process.platform} yet`,
      });
    },
  );
});
