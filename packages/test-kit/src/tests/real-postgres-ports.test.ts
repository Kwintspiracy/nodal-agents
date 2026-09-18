// real-postgres-ports.test.ts — un cluster de test ne prend JAMAIS un port de
// l'installation (issue #130).
//
// Pourquoi cela compte, et pourquoi la réparation est ici plutôt que dans
// `nodal-agents up` : un postmaster de test survivant assis sur le port
// Postgres du poste de travail est un ÉTRANGER pour `up`, dont la preuve de
// propriété passe par le data dir de l'installation. `up` refuse alors de
// démarrer, et il a raison de refuser — `apps/cli/src/lib/orphans.ts` existe
// parce qu'une table de processus ne peut pas dire à qui appartient un cluster,
// et cette leçon a coûté une base vivante le 14/09/2026. On rend donc la
// collision impossible, au lieu d'apprendre au lanceur à tuer ce qu'il croit
// reconnaître.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installedPorts, pickFreePort } from '../real-postgres';

const roots: string[] = [];

function aConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'nodal-ports-test-'));
  roots.push(dir);
  const path = join(dir, 'config.json');
  writeFileSync(path, contents, 'utf-8');
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('installedPorts', () => {
  it('rend les ports déclarés par l’installation', () => {
    const path = aConfig(
      JSON.stringify({ ports: { web: 3000, runner: 3001, postgres: 25444 }, bind: 'lan' }),
    );
    expect(installedPorts(path).sort((a, b) => a - b)).toEqual([3000, 3001, 25444]);
  });

  it('rend une liste vide quand il n’y a pas d’installation à protéger', () => {
    expect(installedPorts(join(tmpdir(), 'nodal-ports-absent', 'config.json'))).toEqual([]);
    expect(installedPorts(aConfig('pas du json'))).toEqual([]);
    expect(installedPorts(aConfig('{}'))).toEqual([]);
  });

  it('ignore ce qui n’est pas un numéro de port', () => {
    expect(
      installedPorts(aConfig(JSON.stringify({ ports: { web: '3000', pg: 0, ok: 25444 } }))),
    ).toEqual([25444]);
  });
});

describe('pickFreePort', () => {
  it('REFUSE un port réservé et en redemande un autre', async () => {
    const handed = [25444, 25444, 49555];
    let i = 0;
    const port = await pickFreePort([3000, 3001, 25444], () => Promise.resolve(handed[i++] ?? 0));
    expect(port).toBe(49555);
    expect(i, 'les deux ports réservés n’ont pas été redemandés').toBe(3);
  });

  it('échoue en le DISANT quand le système ne rend que des ports réservés', async () => {
    await expect(pickFreePort([25444], () => Promise.resolve(25444))).rejects.toThrow(
      /REAL_POSTGRES_NO_PORT/,
    );
  });

  it('sans réserve, rend le port que le système attribue', async () => {
    const port = await pickFreePort([], () => Promise.resolve(25444));
    expect(port).toBe(25444);
  });

  it('demande un VRAI port libre au système quand on ne lui en injecte pas', async () => {
    const port = await pickFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65_536);
  });
});
