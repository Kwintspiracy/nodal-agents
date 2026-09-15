// observed-unreadable.test.ts — ce que l'empreinte ne peut PAS lire.
//
// Revue Codex de la dette de la PR #75, passe 2, constat 2 — un trou ouvert par
// MON correctif de la passe 1. L'empreinte était un `stat` ; elle lit
// maintenant le contenu, et une lecture REFUSÉE tombait dans le même `catch`
// que « le fichier n'existe pas ». Une empreinte valide suivie d'un refus de
// lecture passait donc pour une ÉCRITURE constatée — un faux vert, et le droit
// de déclarer comment on vérifie ce projet derrière. Deux refus de suite
// donnaient l'inverse, un faux rouge sur une écriture réelle.
//
// Le refus se simule, parce qu'il ne se fabrique pas : les droits POSIX ne
// veulent rien dire sous Windows, et un verrou Windows ne se pose pas sous
// Linux. `readFile` seul est remplacé ; `stat` reste le vrai.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type * as FsPromises from 'node:fs/promises';
import type { MutationTarget } from '@nodal-agents/shared';

const lectureRefusee = { valeur: false };

vi.mock('node:fs/promises', async () => {
  const vrai = await vi.importActual<typeof FsPromises>('node:fs/promises');
  return {
    ...vrai,
    readFile: async (...args: Parameters<typeof vrai.readFile>) => {
      if (lectureRefusee.valeur) {
        const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return vrai.readFile(...args);
    },
  };
});

const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { snapshotFileTargets, changedFileTargets } = await import('../verification/observed');

let dir = '';
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nodal-observed-illisible-'));
});
afterAll(async () => {
  lectureRefusee.valeur = false;
  await rm(dir, { recursive: true, force: true });
});

const cible = (path: string): MutationTarget => ({
  kind: 'file',
  path,
  deliverableType: 'code_project',
  scope: 'addressed',
});

describe('un fichier illisible @cap:verifier-un-livrable/moteur', () => {
  it('n’est pas une écriture constatée — le refus de lecture ne se confond pas avec l’absence', async () => {
    const p = join(dir, 'verrouille.ts');
    await writeFile(p, 'export const a = 1;\n');
    const cibles = [cible(p)];
    const snapshot = await snapshotFileTargets(cibles);

    lectureRefusee.valeur = true;
    try {
      expect(await changedFileTargets(cibles, snapshot)).toEqual([]);
    } finally {
      lectureRefusee.valeur = false;
    }
  });

  it('illisible AVANT et écrit APRÈS : l’écriture est constatée quand même', async () => {
    const p = join(dir, 'illisible-avant.ts');
    await writeFile(p, 'export const b = 2;\n');
    const cibles = [cible(p)];

    lectureRefusee.valeur = true;
    const snapshot = await snapshotFileTargets(cibles);
    lectureRefusee.valeur = false;

    await writeFile(p, 'export const c = 3;\nexport const d = 4;\n');

    // L'état d'avant n'a pas pu être lu : rien à conclure du CONTENU, et
    // conclure « inchangé » serait un faux rouge sur une écriture réelle. La
    // taille, elle, se lit sans ouvrir le fichier — et elle a bougé.
    expect(await changedFileTargets(cibles, snapshot)).toEqual(cibles);
  });
});
