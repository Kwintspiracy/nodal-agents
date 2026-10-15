// job-host.test.ts — l'hôte d'un conteneur, lancé pour de vrai (sans
// conteneur : son protocole ne dépend pas du système). Un hôte qui ne joint
// pas le runner le dit, avec l'erreur de l'OS, avant de s'arrêter (#628,
// invariant #4) : c'est ce que la raison du statut cite.

import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureJobHostScript } from '../job-host';

const dir = mkdtempSync(join(tmpdir(), 'nodal-job-host-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Un port où personne n'écoute : ouvert, lu, refermé. */
async function closedPort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as { port: number };
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

function runHost(port: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [ensureJobHostScript(dir), String(port), 'tok'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d: Buffer) => (stdout += String(d)));
  child.stderr.on('data', (d: Buffer) => (stderr += String(d)));
  return new Promise((r) => child.on('close', (code) => r({ code, stdout, stderr })));
}

describe('job host — the host that cannot reach the runner says why @cap:executer-une-commande/moteur', () => {
  it('connexion refusée : sortie 1, et la sortie d’erreur porte le code et le message de l’OS', async () => {
    const port = await closedPort();
    const end = await runHost(port);
    expect(end.code).toBe(1);
    expect(end.stdout).toBe('');
    expect(end.stderr.trim()).toMatch(
      new RegExp(
        `^SANDBOX_HOST_CONNECT_FAILED: ECONNREFUSED connect ECONNREFUSED 127\\.0\\.0\\.1:${port}$`,
      ),
    );
  });

  it('joint, puis lâché par le runner : sortie 0, rien sur la sortie d’erreur', async () => {
    const srv = createServer((sock) => {
      sock.once('data', () => sock.destroy());
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const { port } = srv.address() as { port: number };
    try {
      const end = await runHost(port);
      expect(end.code).toBe(0);
      expect(end.stderr).toBe('');
    } finally {
      srv.close();
    }
  });
});
