// bounded-io.test.ts — le remplissage de dossier borné (issue #1034).
//
// Ce que ces cas prouvent, sur le disque et sur les valeurs rendues :
//   — N fichiers sont écrits, avec le contenu et le nom demandés ;
//   — jamais plus de `concurrency` appels en vol (mesuré par le travail
//     lui-même, pas par un décompte d'appels) ;
//   — un échec rejette, et la distribution s'arrête ;
//   — une concurrence invalide est refusée à voix haute.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOUNDED_IO_CONCURRENCY, mapBounded, writeManyFiles } from '../bounded-io';

let racine = '';

beforeAll(async () => {
  racine = await mkdtemp(join(tmpdir(), 'nodal-bounded-io-'));
});

afterAll(async () => {
  await rm(racine, { recursive: true, force: true });
});

describe('mapBounded', () => {
  it('rend les résultats dans l’ordre des éléments, même quand ils finissent dans le désordre', async () => {
    const out = await mapBounded(
      [30, 1, 15, 2, 8],
      async (ms, i) => {
        await new Promise((r) => setTimeout(r, ms));
        return `${i}:${ms}`;
      },
      3,
    );
    expect(out).toEqual(['0:30', '1:1', '2:15', '3:2', '4:8']);
  });

  it('ne dépasse jamais la concurrence demandée, et l’atteint', async () => {
    let enVol = 0;
    let max = 0;
    await mapBounded(
      Array.from({ length: 40 }, (_, i) => i),
      async () => {
        enVol += 1;
        max = Math.max(max, enVol);
        await new Promise((r) => setTimeout(r, 2));
        enVol -= 1;
      },
      4,
    );
    expect(max).toBe(4);
  });

  it('un rejet arrête la distribution et rejette le tout', async () => {
    const lancés: number[] = [];
    await expect(
      mapBounded(
        Array.from({ length: 100 }, (_, i) => i),
        async (i) => {
          lancés.push(i);
          await new Promise((r) => setTimeout(r, 1));
          if (i === 3) throw new Error('boom 3');
        },
        2,
      ),
    ).rejects.toThrow('boom 3');
    expect(lancés.length).toBeLessThan(100);
  });

  it('refuse une concurrence qui n’est pas un entier positif', async () => {
    await expect(mapBounded([1], async () => 1, 0)).rejects.toThrow(/concurrency/);
    await expect(mapBounded([1], async () => 1, 1.5)).rejects.toThrow(/concurrency/);
  });

  it('une liste vide rend une liste vide', async () => {
    expect(await mapBounded([], async () => 1)).toEqual([]);
  });
});

describe('writeManyFiles', () => {
  it('écrit exactement N fichiers avec le nom et le contenu par défaut', async () => {
    const dir = join(racine, 'defaut');
    const paths = await writeManyFiles(dir, 70);
    expect(paths).toHaveLength(70);
    expect((await readdir(dir)).sort()).toEqual(
      Array.from({ length: 70 }, (_, i) => `f${i}.txt`).sort(),
    );
    expect(await readFile(join(dir, 'f69.txt'), 'utf8')).toBe('69\n');
    expect(paths[5]).toBe(join(dir, 'f5.txt'));
  });

  it('crée les sous-dossiers que les noms portent et respecte nameOf / contentOf', async () => {
    const dir = join(racine, 'sous');
    await writeManyFiles(dir, 3, {
      nameOf: (i) => `d${i % 2}/n-${i}.png`,
      contentOf: (i) => `contenu ${i}`,
    });
    expect((await readdir(join(dir, 'd0'))).sort()).toEqual(['n-0.png', 'n-2.png']);
    expect(await readFile(join(dir, 'd1', 'n-1.png'), 'utf8')).toBe('contenu 1');
  });

  it('une écriture impossible rejette au lieu de rendre un arbre à moitié rempli', async () => {
    const dir = join(racine, 'echec');
    await mkdir(join(dir, 'f2.txt'), { recursive: true }); // un DOSSIER à la place du fichier 2
    await expect(writeManyFiles(dir, 50, { concurrency: 2 })).rejects.toThrow();
  });

  it('la concurrence par défaut est bornée (jamais « tout à la fois »)', () => {
    expect(BOUNDED_IO_CONCURRENCY).toBeGreaterThan(0);
    expect(BOUNDED_IO_CONCURRENCY).toBeLessThan(1001);
  });
});
