// workspace-git-binary.test.ts — QUEL `git` la sonde du workspace lance.
//
// Issue #251. La sonde tournait avec `cwd` sur le workspace — un dossier où
// l'agent écrit — et lançait `git` PAR SON NOM NU. Un `git.exe` déposé là (par
// une dépendance, par un dépôt cloné, par l'agent lui-même) aurait pu répondre
// à la place du git du système sur un runtime dont la recherche de programme
// regarde encore le répertoire courant. Et ce que cette sonde rend n'est pas
// décoratif : c'est la phrase que l'agent lit sur son dépôt, sa branche et la
// propreté de son arbre AVANT d'écrire.
//
// La résolution vit dans `@nodal-agents/shared/git-binary`. Deux cas, parce
// qu'un seul ne suffit pas :
//
//   - le faux git posé dans le workspace : le piège lui-même. Il reste vert sur
//     ce runtime même sans la résolution (Node 26 ne cherche plus le répertoire
//     courant, cf. le commentaire de `git-binary.ts`) — il garde le mécanisme
//     sous les yeux pour un runtime qui chercherait encore ;
//   - la résolution qui répond « aucun git » : la sonde DÉCLINE. C'est le cas
//     qui rougit si quelqu'un remet le nom nu, puisque le nom nu ignorerait la
//     réponse de la résolution et sonderait quand même.

import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtemp, rm, writeFile, copyFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

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

import { resolveGitBinary, _resetGitBinaryCache } from '@nodal-agents/shared/git-binary';

import { probeWorkspaceGit } from '../../lib/workspace-git.ts';

const run = promisify(execFile);

const racines: string[] = [];

afterAll(async () => {
  for (const r of racines) await rm(r, { recursive: true, force: true });
});

async function estUnFichier(chemin: string): Promise<boolean> {
  try {
    return (await stat(chemin)).isFile();
  } catch {
    return false;
  }
}

/** Le git du système, ou l'aveu que la machine n'en a pas — jamais un repli. */
async function vraiGit(): Promise<string> {
  _resetGitBinaryCache();
  const binaire = await resolveGitBinary();
  if (binaire === null) throw new Error('aucun git sur le PATH : ces cas ne prouvent rien');
  return binaire;
}

/** Un dépôt réel, avec un commit et une écriture non commitée. */
async function creerDepot(): Promise<string> {
  const git = await vraiGit();
  const depot = await mkdtemp(join(tmpdir(), 'nodal-ws-git-'));
  racines.push(depot);
  await run(git, ['init', '--initial-branch=principale'], { cwd: depot, windowsHide: true });
  await writeFile(join(depot, 'suivi.txt'), 'bonjour\n');
  await run(git, ['add', 'suivi.txt'], { cwd: depot, windowsHide: true });
  await run(git, ['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-m', 'depart'], {
    cwd: depot,
    windowsHide: true,
  });
  await writeFile(join(depot, 'sale.txt'), 'pas encore suivi\n');
  return depot;
}

/**
 * Un faux `git` VRAIMENT exécutable, posé dans le dossier du workspace.
 *
 * Même motif que `packages/tools/src/tests/git-constat.test.ts` : sous Windows
 * il faut un `.exe` — un `.cmd` ne serait pas lancé par `execFile` sans shell,
 * donc ne prouverait rien — alors on recopie un petit exécutable du système.
 * Appelé avec les arguments de `git rev-parse` il sort en erreur, ce qui suffit :
 * s'il était choisi, la sonde ne rendrait rien.
 *
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

describe('la sonde git du workspace @cap:travailler-sur-des-fichiers/moteur', () => {
  it('un faux git POSÉ DANS LE WORKSPACE n’est pas celui qui répond', async () => {
    const depot = await creerDepot();

    const faux = join(depot, process.platform === 'win32' ? 'git.exe' : 'git');
    const posé = await poserUnFauxGit(faux);
    if (!posé) {
      console.warn(
        '[tests] CAS SAUTÉ — impossible de fabriquer un faux exécutable ici.\n' +
          '        La résolution reste prouvée par le cas suivant et par\n' +
          '        packages/shared/src/tests/git-binary.test.ts.',
      );
      return;
    }
    // Le piège est posé APRÈS la résolution mémoïsée : on la remet à zéro pour
    // que la question soit vraiment reposée avec le faux en place.
    _resetGitBinaryCache();

    const etat = await probeWorkspaceGit(depot);

    // Une VRAIE réponse, pas un `null` : le git du système a tourné.
    expect(etat, 'la sonde ne rend rien : un faux git a pu répondre').not.toBeNull();
    expect(etat?.branch).toBe('principale');
    // `sale.txt` ET le faux git lui-même : deux entrées non suivies.
    expect(etat?.dirtyCount).toBe(2);
    expect(etat?.head).toMatch(/^[0-9a-f]{7,}$/);

    await rm(faux, { force: true });
    _resetGitBinaryCache();
  });

  it('« aucun git sur le PATH » fait DÉCLINER la sonde, jamais retomber sur le nom nu', async () => {
    // Le dépôt est réel et git est installé : si la sonde ignorait la
    // résolution et lançait `git` nu, elle rendrait l'état de ce dépôt-là.
    const depot = await creerDepot();

    resolutionForcee.valeur = null;
    try {
      expect(
        await probeWorkspaceGit(depot),
        'la sonde a sondé alors que la résolution a dit « aucun git »',
      ).toBeNull();
    } finally {
      resolutionForcee.valeur = undefined;
    }
  });
});
