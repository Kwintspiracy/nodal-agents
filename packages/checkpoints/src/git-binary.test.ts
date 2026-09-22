// git-binary.test.ts — QUEL `git` le magasin de checkpoints lance.
//
// Issue #251. Les quatre commandes du magasin — `add`, `commit-tree`, le diff
// en flux, l'`init --bare` — partaient par le NOM NU, avec `GIT_WORK_TREE` sur
// le workspace du propriétaire, c'est-à-dire sur le dossier même que l'agent
// est en train de modifier. Même famille de risque que le constat d'écritures
// (#227) : un `git.exe` déposé là aurait pu répondre à la place du git du
// système sur un runtime dont la recherche de programme regarde encore le
// répertoire courant. Et ce qui est en jeu ici est le FILET : un instantané qui
// ne photographie rien laisse une écriture sans retour arrière.
//
// Deux cas, comme pour la sonde du runner :
//
//   - le faux git posé dans le workspace : le piège. Il reste vert sur ce
//     runtime même sans la résolution (cf. `git-binary.ts`), et garde le
//     mécanisme sous les yeux pour un runtime qui chercherait encore ;
//   - « aucun git » : le magasin LÈVE, fort et clair, avec le code `git_missing`.
//     C'est le cas qui rougit si quelqu'un remet le nom nu, puisque le nom nu
//     ignorerait la réponse de la résolution et photographierait quand même.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, copyFile, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Ce que la résolution doit répondre ; `undefined` = la vraie réponse. */
const resolutionForcee = vi.hoisted(() => ({ valeur: undefined as string | null | undefined }));

vi.mock('@nodal-agents/shared/git-binary', async (importOriginal) => {
  const vrai = await importOriginal<typeof import('@nodal-agents/shared/git-binary')>();
  return {
    ...vrai,
    resolveGitBinary: async (): Promise<string | null> =>
      resolutionForcee.valeur === undefined ? vrai.resolveGitBinary() : resolutionForcee.valeur,
  };
});

import { _resetGitBinaryCache } from '@nodal-agents/shared/git-binary';
import { snapshot, restoreCheckpoint, listCheckpoints } from './checkpoints';
import { isCheckpointError } from './failure';

let root: string;
let store: string;
let ws: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nodal-cp-git-'));
  store = join(root, 'checkpoints');
  ws = join(root, 'workspace');
  await mkdir(ws, { recursive: true });
  _resetGitBinaryCache();
});

afterEach(async () => {
  resolutionForcee.valeur = undefined;
  _resetGitBinaryCache();
  await rm(root, { recursive: true, force: true });
});

async function estUnFichier(chemin: string): Promise<boolean> {
  try {
    return (await stat(chemin)).isFile();
  } catch {
    return false;
  }
}

/**
 * Un faux `git` VRAIMENT exécutable, posé dans le workspace photographié.
 *
 * Même motif que `packages/tools/src/tests/git-constat.test.ts` : sous Windows
 * il faut un `.exe`, un `.cmd` ne serait pas lancé par `execFile` sans shell.
 * Rend `false` quand la machine ne permet pas d'en fabriquer un — le cas se
 * saute alors EN LE DISANT.
 */
async function poserUnFauxGit(chemin: string): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      const source = join(process.env['SystemRoot'] ?? 'C:/Windows', 'System32', 'whoami.exe');
      if (!(await estUnFichier(source))) return false;
      await copyFile(source, chemin);
      return true;
    }
    await writeFile(chemin, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    return true;
  } catch {
    return false;
  }
}

describe('le git du magasin de checkpoints @cap:verifier-un-livrable/moteur', () => {
  it('un faux git POSÉ DANS LE WORKSPACE ne photographie rien à la place du vrai', async () => {
    await writeFile(join(ws, 'note.txt'), 'avant\n');

    const faux = join(ws, process.platform === 'win32' ? 'git.exe' : 'git');
    const posé = await poserUnFauxGit(faux);
    if (!posé) {
      console.warn(
        '[tests] CAS SAUTÉ — impossible de fabriquer un faux exécutable ici.\n' +
          '        La résolution reste prouvée par le cas suivant et par\n' +
          '        packages/shared/src/tests/git-binary.test.ts.',
      );
      return;
    }
    _resetGitBinaryCache();

    const cp = await snapshot(store, ws, 'before file_write');
    // Un vrai commit : un faux git n'aurait produit ni sha ni objets.
    expect(cp?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await listCheckpoints(store, ws)).toHaveLength(1);
    if (cp === null) return;

    // Et le filet TIENT : l'écriture d'après est vraiment annulée, au CONTENU.
    await writeFile(join(ws, 'note.txt'), 'après\n');
    await restoreCheckpoint(store, ws, cp.sha);
    expect(await readFile(join(ws, 'note.txt'), 'utf-8')).toBe('avant\n');
  });

  it('« aucun git sur le PATH » fait LEVER le magasin, jamais retomber sur le nom nu', async () => {
    await writeFile(join(ws, 'note.txt'), 'bonjour\n');

    // git EST installé : si le magasin ignorait la résolution et lançait `git`
    // nu, l'instantané réussirait et ce cas rougirait.
    resolutionForcee.valeur = null;

    const err = await snapshot(store, ws, 'before run_command').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err, "l'instantané a réussi alors que la résolution a dit « aucun git »").not.toBeNull();
    expect(isCheckpointError(err)).toBe(true);
    if (!isCheckpointError(err)) return;
    expect(err.code).toBe('git_missing');
    // Fort et clair, et jusqu'au propriétaire : la phrase rendue dit que git
    // manque, pas « erreur inattendue ».
    expect(err.message).toContain('git is not available');
    expect(err.gitMessage).toContain('git is not on PATH');
  });
});
