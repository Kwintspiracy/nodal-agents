// markers-unc.test.ts — ce que `realPathOf` SONDE quand rien n'existe (revue
// Codex, passe 34) : jamais `//serveur` seul (une résolution réseau synchrone
// vers un serveur absent bloquerait le runner), jamais `C:` seul (le dossier
// courant du lecteur, pas sa racine). Le disque est remplacé par un espion qui
// refuse tout et note chaque sonde — c'est la seule façon de prouver ce qui
// N'est PAS tenté sans dépendre d'un réseau.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const probes: string[] = [];
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    realpathSync: Object.assign(
      (p: string) => {
        probes.push(String(p));
        throw new Error('ENOENT');
      },
      {
        native: (p: string) => {
          probes.push(String(p));
          throw new Error('ENOENT');
        },
      },
    ),
  };
});

import { realPathOf } from '../../projects/markers';

beforeEach(() => {
  probes.length = 0;
});

describe('realPathOf — ce qui est sondé', () => {
  it('un chemin UNC : la remontée s’arrête au partage, jamais le serveur seul', () => {
    const p = '//nas-indisponible/projets/app/src/x.ts';
    expect(realPathOf(p)).toBe(p);
    expect(probes).toContain('//nas-indisponible/projets');
    expect(probes).not.toContain('//nas-indisponible');
    expect(probes).not.toContain('/');
  });

  it('un chemin de lecteur : `C:/` est sondé, jamais `C:`', () => {
    const p = 'C:/nulle/part/x.ts';
    expect(realPathOf(p)).toBe(p);
    expect(probes).toContain('C:/');
    expect(probes).not.toContain('C:');
  });

  it('un chemin POSIX : la racine `/` n’est pas sondée', () => {
    const p = '/nulle/part/x.ts';
    expect(realPathOf(p)).toBe(p);
    expect(probes).toEqual([p, '/nulle/part', '/nulle']);
  });
});
