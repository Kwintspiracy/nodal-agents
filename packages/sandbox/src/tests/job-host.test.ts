// job-host.test.ts — l'hôte d'un conteneur, lancé pour de vrai, sans conteneur :
// son canal (ses flux standard, que le courtier relaie) ne dépend pas du
// système. Il ne joint rien, n'écoute rien : il lit son entrée, répond sur sa
// sortie, et s'arrête quand son entrée se ferme (#628).

import { describe, it, expect, afterAll } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureJobHostScript } from '../job-host';
import { windowsSpawnParts } from '../command-line';

const dir = mkdtempSync(join(tmpdir(), 'nodal-job-host-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface HostLine {
  ready?: boolean;
  pid?: number;
  id?: number;
  started?: number;
  s?: 'o' | 'e';
  d?: string;
  exit?: number | null;
  error?: string;
}

/** L'hôte, et ses lignes JSON au fil de l'eau. */
function startHost(): { child: ChildProcessWithoutNullStreams; lines: HostLine[] } {
  const child = spawn(process.execPath, [ensureJobHostScript(dir)], { stdio: 'pipe' });
  const lines: HostLine[] = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let at: number;
    while ((at = buffer.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buffer.slice(0, at)) as HostLine);
      buffer = buffer.slice(at + 1);
    }
  });
  return { child, lines };
}

async function until(test: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !test(); i++) await new Promise((r) => setTimeout(r, 25));
  expect(test()).toBe(true);
}

// La commande telle que le runner la décrit à l'hôte (windows-mxc.ts).
const target = { file: process.execPath, args: ['-e', "process.stdout.write('hi')"] };

describe('job host — its channel is its standard streams @cap:executer-une-commande/moteur', () => {
  it.runIf(process.platform === 'win32')(
    'init → ready ; run → started, la sortie de la commande, son code ; l’entrée fermée, il s’arrête (code 0)',
    async () => {
      const { child, lines } = startHost();
      const env = Object.fromEntries(
        Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
      );
      child.stdin.write(`${JSON.stringify({ op: 'init', env })}\n`);
      await until(() => lines.some((l) => l.ready));
      expect(lines.find((l) => l.ready)?.pid).toBe(child.pid);

      child.stdin.write(
        `${JSON.stringify({ op: 'run', id: 1, ...windowsSpawnParts(target, 'cmd.exe'), cwd: dir, env })}\n`,
      );
      await until(() => lines.some((l) => l.id === 1 && 'exit' in l));
      const out = lines
        .filter((l) => l.id === 1 && l.s === 'o')
        .map((l) => Buffer.from(l.d ?? '', 'base64').toString('utf8'))
        .join('');
      expect(out).toBe('hi');
      expect(lines.some((l) => l.id === 1 && typeof l.started === 'number')).toBe(true);
      expect(lines.find((l) => l.id === 1 && 'exit' in l)?.exit).toBe(0);

      const closed = new Promise<number | null>((r) => child.on('close', (code) => r(code)));
      child.stdin.end();
      expect(await closed).toBe(0);
    },
  );

  it('n’ouvre aucune connexion : sa source ne charge ni `net` ni `http`', async () => {
    const { JOB_HOST_SOURCE } = await import('../job-host');
    expect(JOB_HOST_SOURCE).not.toMatch(/require\('(net|http|https|dgram)'\)/);
  });

  it('son entrée fermée, il sort 0 et le dit sur sa sortie d’erreur (jamais une raison vide)', async () => {
    const { child } = startHost();
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += String(d)));
    const closed = new Promise<number | null>((r) => child.on('close', (code) => r(code)));
    child.stdin.end();
    expect(await closed).toBe(0);
    expect(stderr.trim()).toBe('SANDBOX_HOST_INPUT_CLOSED');
  });
});
