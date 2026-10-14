// windows-mxc.test.ts — le backend MXC, sondé et démarré pour de vrai.

import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { mxcBackend, MXC_BACKEND_NAME } from '../windows-mxc';
import { SandboxStartError } from '../types';

describe('mxcBackend — SDK absent (tous systèmes)', () => {
  it('la sonde dit SANDBOX_BACKEND_MISSING avec la raison du chargement ; un démarrage est refusé', async () => {
    const backend = mxcBackend(() =>
      Promise.reject(new Error("Cannot find package '@microsoft/mxc-sdk'")),
    );
    expect(await backend.probe()).toEqual({
      state: 'unavailable',
      code: 'SANDBOX_BACKEND_MISSING',
      reason: "Cannot find package '@microsoft/mxc-sdk'",
    });
    await expect(
      backend.start({ target: { command: 'exit 0' }, cwd: tmpdir(), env: {}, writableRoots: [] }),
    ).rejects.toBeInstanceOf(SandboxStartError);
  });
});

describe.skipIf(process.platform !== 'win32')(
  'mxcBackend — le vrai MXC (Windows only: MXC is the Windows backend of #628)',
  () => {
    it('la sonde lance une commande confinée triviale et rend `available`', async () => {
      const status = await mxcBackend().probe();
      expect(status, JSON.stringify(status)).toEqual({
        state: 'available',
        backend: MXC_BACKEND_NAME,
      });
    });

    it('un démarrage que MXC refuse lève SandboxStartError avec SA raison (ici : LOCALAPPDATA absent)', async () => {
      const env = { SYSTEMROOT: process.env['SYSTEMROOT'], PATH: process.env['PATH'] };
      const error = await mxcBackend()
        .start({ target: { command: 'exit 0' }, cwd: tmpdir(), env, writableRoots: [] })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(SandboxStartError);
      expect((error as SandboxStartError).message).toMatch(
        /^SANDBOX_START_FAILED: policy_validation: .*LOCALAPPDATA/,
      );
    });
  },
);
