// source-files.ts — ce qui est SOURCE dans le dépôt, une définition pour tous les scanners.
//
// Les scanners d'invariants parcourent apps/, packages/ et scripts/. Chacun
// portait sa liste de dossiers à sauter (`node_modules`, `dist`, `.next`,
// `.turbo`…), et aucune ne connaissait `.next-studio`, le dossier de build de
// Bench Studio : un propriétaire qui avait ouvert le Studio voyait
// `release:check` rouge sur ses propres chunks compilés (0.9.8, 23/10). Une
// liste de plus aurait attendu le prochain dossier de build.
//
// La définition est celle de git : un fichier est source s'il est SUIVI, ou
// nouveau et NON IGNORÉ (`git ls-files --cached --others --exclude-standard`).
// Le .gitignore du dépôt dit déjà, une fois, ce qui est produit (build, cache,
// dépendances) ; un nouveau dossier de build y est ajouté le jour où il naît,
// sinon `git status` le montre à tous. Un fichier source pas encore ajouté est
// lu (on ne laisse pas passer une violation parce qu'elle n'est pas commitée),
// un fichier suivi effacé ne l'est pas.
//
// Sans dépôt git (une archive `git archive`, un dossier copié) : refus, avec
// la raison. Un scanner ne devine pas ce qui est source ; retomber sur une
// liste de noms reviendrait à la règle qui a cassé (invariant #4). La CI et
// les worktrees ont tous un `.git`.
//
// Le piège de ce refus : une copie sans `.git` posée DANS un autre dépôt. git
// remonte alors jusqu'à lui (le dossier personnel du propriétaire en est un
// sur sa machine, et un paquet de relecture s'extrait sous ce dossier), et
// répondrait avec SES règles : s'il ignore la copie, aucun fichier, donc
// aucune violation, en silence. Un dossier qui n'est pas le haut de son dépôt
// et sous lequel ce dépôt ne suit RIEN est donc refusé lui aussi.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** La sortie de `git <args>` lancé dans `root`, ou le refus qui dit pourquoi. */
function gitIn(root: string, args: readonly string[]): string {
  const r = spawnSync('git', [...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) {
    throw new Error(
      `source_files_need_git: ${root}: ${(r.error?.message ?? r.stderr).trim()} ` +
        "(the invariant scanners read git's own view of what is source: tracked, or new and not ignored; " +
        'run them from a clone or a worktree, never from a copy without .git)',
    );
  }
  return r.stdout;
}

/**
 * Les fichiers source sous `dir` (chemins absolus, triés) : suivis par git, ou
 * nouveaux et non ignorés, et présents sur le disque. Jamais un fichier que le
 * `.gitignore` du dépôt range parmi les produits (build, cache, dépendances).
 *
 * git est lancé DANS `dir` et rend des chemins relatifs à lui : aucun chemin
 * absolu de git n'est comparé à `dir`. Sous Windows, le dossier temporaire a
 * souvent un nom court (`RUNNER~1`) que git rendrait en long, et un préfixe
 * comparé entre les deux formes ne retiendrait RIEN, en silence.
 */
export function sourceFilesUnder(dir: string): string[] {
  const root = resolve(dir);
  if (!existsSync(root)) return [];
  // '' au haut d'un dépôt, le chemin depuis ce haut ailleurs.
  const fromTop = gitIn(root, ['rev-parse', '--show-prefix']).trim();
  // `-t` étiquette chaque entrée : `? ` pour un fichier non suivi, une lettre
  // (`H`, `S`…) pour un fichier suivi.
  const entries = gitIn(root, [
    'ls-files',
    '-z',
    '-t',
    '--cached',
    '--others',
    '--exclude-standard',
  ])
    .split('\0')
    .filter(Boolean)
    .map((e) => ({ tracked: !e.startsWith('? '), rel: e.slice(2) }));
  if (fromTop !== '' && !entries.some((e) => e.tracked)) {
    throw new Error(
      `source_files_not_tracked: ${root}: the git work tree around it tracks nothing under it ` +
        `(it sits at ${fromTop} of that tree): a copy without its own .git inside another repository? ` +
        "That repository's rules would decide what is source; run the scanners from a clone or a worktree",
    );
  }
  return [...new Set(entries.map((e) => join(root, e.rel)).filter((f) => existsSync(f)))].sort();
}

/**
 * Un dossier temporaire qui est un dépôt git vide : l'arbre où un test fabrique
 * des sources pour un scanner. Le scanner y lit ce que git y voit, exactement
 * comme dans le vrai dépôt (un fichier écrit et non ignoré est source).
 */
export function mkdtempSourceTree(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const r = spawnSync('git', ['init', '-q', dir], { encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) {
    throw new Error(
      `source_tree_git_init_failed: ${dir}: ${(r.error?.message ?? r.stderr).trim()}`,
    );
  }
  return dir;
}
