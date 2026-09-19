// project-git.test.ts — POSER GIT, et ne rien poser quand il ne faut pas
// (issue #200).
//
// Tout se passe sur des dossiers temporaires créés par le test : jamais le
// dépôt du projet, jamais un dossier qu'on n'a pas fabriqué soi-même. Le
// module ÉCRIT (il crée `.git/`, il peut écrire un `.gitignore`), donc les
// assertions portent sur ce que le disque contient après.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizePath } from '@nodal-agents/shared';
import { GITIGNORE_MINIMAL, initGitRepository } from '../project-git.ts';
import { resolveGitBinary, _resetGitBinaryCache } from '@nodal-agents/shared/git-binary';

const run = promisify(execFile);

let racine = '';

beforeEach(async () => {
  racine = await mkdtemp(join(tmpdir(), 'nodal-project-git-'));
});

afterEach(async () => {
  await rm(racine, { recursive: true, force: true });
});

async function estUnFichier(chemin: string): Promise<boolean> {
  try {
    return (await stat(chemin)).isFile();
  } catch {
    return false;
  }
}

/**
 * Un faux `git` VRAIMENT exécutable, posé dans le dossier du projet.
 *
 * Sous Windows il faut un `.exe` : `execFile` sans shell ne lancerait pas un
 * `.cmd`, donc un `.cmd` ne prouverait rien. On recopie un petit exécutable du
 * système ; appelé avec les arguments de `git init` il sortirait en erreur, ce
 * qui suffit — s'il était choisi, le dépôt ne serait pas posé.
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

async function dossier(nom: string): Promise<string> {
  const p = join(racine, nom);
  await mkdir(p, { recursive: true });
  return p;
}

describe('initGitRepository @cap:travailler-sur-des-fichiers/moteur', () => {
  it('pose un vrai dépôt et son .gitignore', async () => {
    const p = await dossier('neuf');

    const out = await initGitRepository(p);

    expect(out).toEqual({ kind: 'initialised', gitignoreWritten: true });
    expect(existsSync(join(p, '.git'))).toBe(true);
    // Un VRAI dépôt, pas un dossier `.git` vide : git lui-même doit le
    // reconnaître.
    const { stdout } = await run('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: p,
      windowsHide: true,
    });
    expect(stdout.trim()).toBe('true');
    expect(await readFile(join(p, '.gitignore'), 'utf8')).toBe(GITIGNORE_MINIMAL);
  });

  it('le .gitignore couvre les dépendances, la sortie de build et les secrets', () => {
    // Trois lignes, et pas une devinette de pile. `.env*` est celle dont
    // l'oubli ne se rattrape pas : un secret poussé est un secret brûlé.
    expect(GITIGNORE_MINIMAL.split('\n').filter((l) => l !== '')).toEqual([
      'node_modules/',
      'dist/',
      '.env*',
    ]);
  });

  it('un dossier DÉJÀ dépôt n’est pas retouché', async () => {
    const p = await dossier('deja');
    await run('git', ['init'], { cwd: p, windowsHide: true });
    await writeFile(join(p, '.gitignore'), 'le mien\n');

    const out = await initGitRepository(p);

    expect(out).toEqual({ kind: 'already' });
    // Le `.gitignore` de quelqu'un d'autre n'est pas un défaut à corriger.
    expect(await readFile(join(p, '.gitignore'), 'utf8')).toBe('le mien\n');
  });

  it('un .gitignore déjà écrit dans un dossier neuf n’est pas écrasé', async () => {
    const p = await dossier('avec-ignore');
    await writeFile(join(p, '.gitignore'), 'rien/\n');

    const out = await initGitRepository(p);

    expect(out).toEqual({ kind: 'initialised', gitignoreWritten: false });
    expect(existsSync(join(p, '.git'))).toBe(true);
    expect(await readFile(join(p, '.gitignore'), 'utf8')).toBe('rien/\n');
  });

  it('la question est CE DOSSIER-CI, pas « suis-je dans un dépôt »', async () => {
    // Un projet créé sous un dossier personnel lui-même versionné doit avoir
    // SON dépôt. `git rev-parse` aurait répondu « déjà un dépôt » en remontant
    // au parent, et ce projet n'en aurait jamais eu — le même piège que la
    // racine retenue par le constat (#199).
    const parent = await dossier('parent-versionne');
    await run('git', ['init'], { cwd: parent, windowsHide: true });
    const enfant = join(parent, 'projet');
    await mkdir(enfant, { recursive: true });

    const out = await initGitRepository(enfant);

    expect(out).toEqual({ kind: 'initialised', gitignoreWritten: true });
    expect(existsSync(join(enfant, '.git'))).toBe(true);
  });

  it('un dossier qui n’existe pas ne fait pas planter l’écran : l’échec est RENDU', async () => {
    const out = await initGitRepository(join(racine, 'nulle-part'));

    expect(out.kind).toBe('failed');
  });
});

describe('quel git est lancé @cap:travailler-sur-des-fichiers/moteur', () => {
  // Revue C de la PR #244, constat bloquant. `git init` partait par le NOM NU
  // avec `cwd` = le dossier du projet, c'est-à-dire un dossier où des agents
  // écrivent. C'est la règle que #227 a posée pour le constat, et c'est le même
  // `git` lancé de la même façon : la résolution est donc PARTAGÉE
  // (`@nodal-agents/shared/git-binary`), pas recopiée.
  //
  // Ce que ce cas prouve et ce qu'il ne prouve pas : sur ce runtime, `execFile`
  // ne cherche plus le répertoire courant (mesuré dans #227, Node 26.4.0), donc
  // le faux ne serait pas pris même sans la résolution. Le cas garde le
  // mécanisme sous les yeux pour un runtime qui chercherait encore ; ce qui
  // rougit à la mutation, c'est le chemin absolu lui-même.

  it('le binaire est un chemin ABSOLU, et un faux posé dans le projet ne l’est pas', async () => {
    const p = await dossier('faux-git');
    const binaire = await resolveGitBinary();
    expect(binaire).not.toBeNull();
    expect(binaire === null || /^([A-Za-z]:\/|\/)/.test(binaire)).toBe(true);

    const faux = join(p, process.platform === 'win32' ? 'git.exe' : 'git');
    const posé = await poserUnFauxGit(faux);
    if (!posé) {
      console.warn(
        '[tests] CAS SAUTÉ — impossible de fabriquer un faux exécutable ici.\n' +
          '        Le chemin absolu reste affirmé au-dessus.',
      );
      return;
    }

    _resetGitBinaryCache();
    expect(await resolveGitBinary()).not.toBe(normalizePath(faux));

    // ET la pose marche encore : si le faux avait été lancé, `git init` aurait
    // échoué et le dossier n'aurait pas de dépôt.
    const out = await initGitRepository(p);
    expect(out.kind).toBe('initialised');
    expect(existsSync(join(p, '.git'))).toBe(true);

    _resetGitBinaryCache();
  });
});
