// observed-fingerprint.test.ts — ce qu'une écriture CONSTATÉE sait constater.
//
// Revue Codex post-merge de la PR #75, constat 3. L'empreinte d'un fichier
// était `{ size, mtimeNs }`, et l'en-tête du module annonçait un seul trou :
// « un contenu réécrit à l'identique dans la même nanoseconde ». Ce n'était pas
// le trou. `mtimeNs` porte des nanosecondes, il ne les MESURE pas : la
// résolution est celle du système de fichiers, et elle va de la nanoseconde à
// DEUX SECONDES (FAT), en passant par la seconde de plusieurs montages réseau.
// Une réécriture de même taille dans cette fenêtre passait pour « rien n'a
// changé », et le livrable restait `produced = false` sur un fichier bel et
// bien écrit — un faux rouge, et le refus de `declare_verification` derrière.
//
// Le test ne suppose aucune plateforme : il REMET la date d'avant avec
// `utimes`, ce qui reproduit exactement ce qu'une horloge grossière donne.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MutationTarget } from '@nodal-agents/shared';
import { snapshotFileTargets, changedFileTargets } from '../verification/observed';

let dir = '';
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nodal-observed-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const cible = (path: string): MutationTarget => ({
  kind: 'file',
  path,
  deliverableType: 'code_project',
  scope: 'addressed',
});

describe('l’empreinte d’une écriture constatée @cap:verifier-un-livrable/moteur', () => {
  it('une réécriture de MÊME TAILLE sous une horloge grossière est constatée', async () => {
    const p = join(dir, 'meme-taille.ts');
    // Une date POSÉE, la même des deux côtés : c'est ce qu'une horloge de
    // système de fichiers grossière donne à lire, sans dépendre de la sienne.
    const horloge = new Date(1_600_000_000_000);
    await writeFile(p, 'export const x = 1;\n');
    await utimes(p, horloge, horloge);
    const cibles = [cible(p)];

    const snapshot = await snapshotFileTargets(cibles);

    // Même longueur, contenu différent — et la même date, remise à la main.
    await writeFile(p, 'export const y = 2;\n');
    await utimes(p, horloge, horloge);
    expect((await stat(p, { bigint: true })).mtimeNs).toBe(BigInt(horloge.getTime()) * 1_000_000n);

    expect(await changedFileTargets(cibles, snapshot)).toEqual(cibles);
  });

  it('un fichier VRAIMENT inchangé ne devient pas une écriture', async () => {
    const p = join(dir, 'intact.ts');
    await writeFile(p, 'export const z = 3;\n');
    const cibles = [cible(p)];
    const snapshot = await snapshotFileTargets(cibles);

    expect(await changedFileTargets(cibles, snapshot)).toEqual([]);
  });

  it('un fichier absent qui apparaît, et un fichier qui disparaît, sont deux changements', async () => {
    const neuf = join(dir, 'neuf.ts');
    const parti = join(dir, 'parti.ts');
    await writeFile(parti, 'export const w = 4;\n');
    const cibles = [cible(neuf), cible(parti)];
    const snapshot = await snapshotFileTargets(cibles);

    await writeFile(neuf, 'export const v = 5;\n');
    await rm(parti);

    expect((await changedFileTargets(cibles, snapshot)).map((t) => t.path).sort()).toEqual(
      [neuf, parti].sort(),
    );
  });
});
