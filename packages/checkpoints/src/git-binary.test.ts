// git-binary.test.ts — QUEL `git` le magasin de checkpoints lance.
//
// Issue #251. Les quatre lancements du magasin — `git()`, `gitRaw()`, le diff
// en flux `gitRawCapped()` et l'`init --bare` d'`ensureStore()` — partaient par
// le NOM NU, avec `GIT_WORK_TREE` sur le workspace du propriétaire, c'est-à-dire
// sur le dossier même que l'agent est en train de modifier. Même famille de
// risque que le constat d'écritures (#227). Et ce qui est en jeu ici est le
// FILET : un instantané qui ne photographie rien laisse une écriture sans
// retour arrière.
//
// ## Ce que ce fichier prouve, site par site (revue Codex passe 1 sur #436)
//
// Un seul cas « aucun git » ne prouve RIEN sur les quatre sites : sur un
// magasin vierge il échoue à `ensureStore()` et n'atteint jamais les trois
// autres, donc remettre l'un d'eux au nom nu le laisserait vert. Il y a donc
// QUATRE cas, chacun conçu pour atteindre SON site :
//
//   - `git()` : `listCheckpoints` sur un magasin déjà photographié — la lecture
//     du journal ne passe ni par `ensureStore` ni par les diffs ;
//   - `gitRaw()` : le `--numstat` d'un diff de fichier BINAIRE — git répond
//     « binaire » et la lecture s'arrête là, avant le diff en flux ;
//   - `gitRawCapped()` : le diff en flux d'un fichier texte ;
//   - `ensureStore()` : la création du dépôt nu, appelée directement.
//
// Chaque cas commence par MESURER combien de résolutions son opération demande
// quand tout va bien, et l'affirme : si l'ordre interne change, le cas rougit
// au lieu d'armer silencieusement le mauvais rang. Puis il rejoue la même
// opération avec « aucun git » À PARTIR DE CE RANG-LÀ, et exige le refus.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, copyFile, stat, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Le résolveur contrôlé : il rend le VRAI git tant que le rang du lancement est
 * sous `echecAPartirDe`, et « aucun git » à partir de là. Compter les rangs est
 * ce qui permet d'atteindre un site précis alors que plusieurs lancements se
 * suivent dans une même opération.
 */
const resolution = vi.hoisted(() => ({
  compte: 0,
  echecAPartirDe: undefined as number | undefined,
}));

vi.mock('@nodal-agents/shared/git-binary', async (importOriginal) => {
  const vrai = await importOriginal<typeof import('@nodal-agents/shared/git-binary')>();
  return {
    ...vrai,
    resolveGitBinary: async (): Promise<string | null> => {
      const rang = ++resolution.compte;
      if (resolution.echecAPartirDe !== undefined && rang >= resolution.echecAPartirDe) return null;
      return vrai.resolveGitBinary();
    },
  };
});

import { _resetGitBinaryCache } from '@nodal-agents/shared/git-binary';
import { snapshot, restoreCheckpoint, listCheckpoints, diffFile, ensureStore } from './checkpoints';
import { isCheckpointError } from './failure';

let root: string;
let store: string;
let ws: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nodal-cp-git-'));
  store = join(root, 'checkpoints');
  ws = join(root, 'workspace');
  await mkdir(ws, { recursive: true });
  resolution.compte = 0;
  resolution.echecAPartirDe = undefined;
  _resetGitBinaryCache();
});

afterEach(async () => {
  resolution.echecAPartirDe = undefined;
  resolution.compte = 0;
  _resetGitBinaryCache();
  await rm(root, { recursive: true, force: true });
});

/** Combien de fois l'opération demande le binaire quand tout va bien. */
async function lancementsDe(operation: () => Promise<unknown>): Promise<number> {
  resolution.echecAPartirDe = undefined;
  resolution.compte = 0;
  await operation();
  return resolution.compte;
}

/**
 * Rejoue l'opération avec « aucun git » à partir du `rang`-ième lancement, et
 * rend ce qui a été levé — `null` si l'opération a abouti, ce qui est déjà le
 * verdict : un site remis au nom nu ne demande plus rien à la résolution.
 */
async function refusAuRang(rang: number, operation: () => Promise<unknown>): Promise<unknown> {
  resolution.compte = 0;
  resolution.echecAPartirDe = rang;
  try {
    await operation();
    return null;
  } catch (err) {
    return err;
  } finally {
    resolution.echecAPartirDe = undefined;
  }
}

/** Deux instantanés, un fichier texte et un fichier binaire modifiés entre les deux. */
async function deuxInstantanes(): Promise<{ avant: string; apres: string }> {
  await writeFile(join(ws, 'note.txt'), 'une ligne\n');
  await writeFile(join(ws, 'image.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0x00]));
  const a = await snapshot(store, ws, 'avant');
  await writeFile(join(ws, 'note.txt'), 'une autre ligne\n');
  await writeFile(join(ws, 'image.bin'), Buffer.from([0x00, 0x09, 0x09, 0x00, 0xfe, 0x00]));
  const b = await snapshot(store, ws, 'après');
  if (a === null || b === null) throw new Error('fixture : un instantané attendu est vide');
  return { avant: a.sha, apres: b.sha };
}

/** Le refus attendu d'une LECTURE : une CheckpointError qui dit `git_missing`. */
function exigerGitMissing(err: unknown): void {
  expect(err, "l'opération a abouti alors que la résolution a dit « aucun git »").not.toBeNull();
  expect(isCheckpointError(err)).toBe(true);
  if (!isCheckpointError(err)) return;
  expect(err.code).toBe('git_missing');
  expect(err.gitMessage).toContain('git is not on PATH');
}

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
  it('git() : lire le journal LÈVE quand la résolution dit « aucun git »', async () => {
    await deuxInstantanes();
    const lire = (): Promise<unknown> => listCheckpoints(store, ws);

    // Le résultat réel d'abord : les deux photos sont bien là, donc l'opération
    // lit vraiment le journal.
    expect(await listCheckpoints(store, ws)).toHaveLength(2);
    // Et elle ne lance git qu'UNE fois : le rang 1 est donc `git()` lui-même,
    // pas `ensureStore` (cette lecture ne l'appelle pas) ni un diff.
    expect(await lancementsDe(lire)).toBe(1);

    exigerGitMissing(await refusAuRang(1, lire));
  });

  it('gitRaw() : le `--numstat` d’un diff binaire LÈVE, il ne rend pas « inchangé »', async () => {
    const { avant, apres } = await deuxInstantanes();
    const lire = (): Promise<unknown> => diffFile(store, ws, avant, apres, 'image.bin');

    // Résultat réel : git répond « binaire » SUR LE NUMSTAT, et la lecture
    // s'arrête là — le diff en flux n'est jamais atteint, ce qui isole ce site.
    expect((await diffFile(store, ws, avant, apres, 'image.bin')).kind).toBe('binary');
    // Deux `ls-tree` par `git()`, puis le `--numstat` par `gitRaw()` : rang 3.
    expect(await lancementsDe(lire)).toBe(3);

    exigerGitMissing(await refusAuRang(3, lire));
  });

  it('gitRawCapped() : le diff EN FLUX LÈVE, il ne rend pas un texte vide', async () => {
    const { avant, apres } = await deuxInstantanes();
    const lire = (): Promise<unknown> => diffFile(store, ws, avant, apres, 'note.txt');

    // Résultat réel : le texte du diff porte bien les deux lignes.
    const diff = await diffFile(store, ws, avant, apres, 'note.txt');
    expect(diff.kind).toBe('diff');
    if (diff.kind === 'diff') {
      expect(diff.text).toContain('-une ligne');
      expect(diff.text).toContain('+une autre ligne');
    }
    // Deux `ls-tree`, le `--numstat`, puis le diff en flux : rang 4.
    expect(await lancementsDe(lire)).toBe(4);

    exigerGitMissing(await refusAuRang(4, lire));
  });

  it('ensureStore() : le dépôt nu n’est PAS créé quand la résolution dit « aucun git »', async () => {
    const magasinNeuf = join(root, 'magasin-neuf');

    const err = await refusAuRang(1, () => ensureStore(magasinNeuf));

    expect(err, 'le magasin a été créé alors qu’aucun git n’était disponible').not.toBeNull();
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('GitBinaryMissingError');
    expect((err as Error).message).toContain('git is not on PATH');
    // Et rien n'a été posé : un `init --bare` au nom nu aurait laissé un dépôt.
    expect(existsSync(join(magasinNeuf, 'store', 'HEAD'))).toBe(false);
  });

  it('« aucun git sur le PATH » fait LEVER le magasin jusqu’au propriétaire', async () => {
    await writeFile(join(ws, 'note.txt'), 'bonjour\n');

    // git EST installé : si le magasin ignorait la résolution et lançait `git`
    // nu, l'instantané réussirait et ce cas rougirait. Ce cas-ci couvre le
    // chemin PUBLIC complet — quel site tombe le premier ne l'intéresse pas,
    // c'est la phrase rendue au propriétaire qu'il épingle.
    const err = await refusAuRang(1, () => snapshot(store, ws, 'before run_command'));

    exigerGitMissing(err);
    if (!isCheckpointError(err)) return;
    // Fort et clair : la phrase rendue dit que git manque, pas « erreur
    // inattendue ».
    expect(err.message).toContain('git is not available');
  });

  it('un faux git POSÉ DANS LE WORKSPACE ne photographie rien à la place du vrai', async () => {
    await writeFile(join(ws, 'note.txt'), 'avant\n');

    const faux = join(ws, process.platform === 'win32' ? 'git.exe' : 'git');
    const posé = await poserUnFauxGit(faux);
    if (!posé) {
      console.warn(
        '[tests] CAS SAUTÉ — impossible de fabriquer un faux exécutable ici.\n' +
          '        La résolution reste prouvée par les quatre cas par site.',
      );
      return;
    }
    _resetGitBinaryCache();

    // CE QUE CE CAS PROUVE, ET RIEN DE PLUS : la résolution rend le git DU
    // SYSTÈME, pas un chemin sous le workspace, et ce git-là répond vraiment —
    // sha réel, objets réels, restauration au contenu. Il ne prouve PAS que les
    // sous-processus du magasin étaient exposés à ce faux binaire : ils ne
    // posent pas `cwd` sur le workspace (`GIT_WORK_TREE` ne change pas la
    // recherche de l'exécutable), donc un `git.exe` déposé là ne serait de
    // toute façon pas trouvé par eux. Ce sont les quatre cas par site qui
    // prouvent la résolution ; celui-ci garde le piège sous les yeux et vérifie
    // que le magasin fonctionne de bout en bout pendant qu'il est posé.
    const cp = await snapshot(store, ws, 'before file_write');
    expect(cp?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await listCheckpoints(store, ws)).toHaveLength(1);
    if (cp === null) return;

    // Et le filet TIENT : l'écriture d'après est vraiment annulée, au CONTENU.
    await writeFile(join(ws, 'note.txt'), 'après\n');
    await restoreCheckpoint(store, ws, cp.sha);
    expect(await readFile(join(ws, 'note.txt'), 'utf-8')).toBe('avant\n');
  });
});
