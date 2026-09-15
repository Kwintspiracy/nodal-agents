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
// Linux. `readFile` et `stat` sont remplacés, chacun par un interrupteur à lui :
// les deux refus se testent séparément, et le reste de `node:fs/promises` est
// le vrai.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type * as FsPromises from 'node:fs/promises';
import type { MutationTarget } from '@nodal-agents/shared';

const lectureRefusee = { valeur: false };
const statRefuse = { valeur: false };

const refus = (code: string): NodeJS.ErrnoException => {
  const err = new Error(`${code}: refusé`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
};

vi.mock('node:fs/promises', async () => {
  const vrai = await vi.importActual<typeof FsPromises>('node:fs/promises');
  return {
    ...vrai,
    readFile: async (...args: Parameters<typeof vrai.readFile>) => {
      if (lectureRefusee.valeur) throw refus('EACCES');
      return vrai.readFile(...args);
    },
    stat: async (...args: Parameters<typeof vrai.stat>) => {
      if (statRefuse.valeur) throw refus('EACCES');
      return vrai.stat(...args);
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
  statRefuse.valeur = false;
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

describe('un fichier dont l’ÉTAT lui-même est refusé @cap:verifier-un-livrable/moteur', () => {
  it('un `stat` refusé n’est pas une absence, donc pas une écriture', async () => {
    // Revue Codex de la dette de la PR #75, passe 3, constat 1. Le troisième
    // état distinguait le refus de LIRE, pas le refus de `stat` : toute erreur
    // d'état retombait sur « absent », et une empreinte valide suivie d'un
    // `EACCES` passait encore pour une écriture. Un résidu d'avant le
    // correctif, pas une régression — et un faux vert quand même.
    //
    // `ENOENT` reste une absence : c'est la seule erreur qui répond à la
    // question posée, « ce fichier existe-t-il ? ».
    const p = join(dir, 'etat-refuse.ts');
    await writeFile(p, 'export const e = 5;');
    const cibles = [cible(p)];
    const snapshot = await snapshotFileTargets(cibles);

    statRefuse.valeur = true;
    try {
      expect(await changedFileTargets(cibles, snapshot)).toEqual([]);
    } finally {
      statRefuse.valeur = false;
    }
  });

  it('un fichier VRAIMENT supprimé reste un changement', async () => {
    const p = join(dir, 'supprime.ts');
    await writeFile(p, 'export const f = 6;');
    const cibles = [cible(p)];
    const snapshot = await snapshotFileTargets(cibles);

    await rm(p);

    expect(await changedFileTargets(cibles, snapshot)).toEqual(cibles);
  });
});
