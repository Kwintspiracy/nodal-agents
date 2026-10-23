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
// Une liste qui ne trouve RIEN là où il y a quelque chose à lire fait passer
// chaque garde au vert sans qu'elle ait rien lu. Deux cas, un seul refus :
//   - le dossier n'existe pas (un paquet renommé, une racine fausse) ;
//   - il contient des fichiers, et git n'en montre aucun comme source (un
//     dossier ignoré, ou une copie sans `.git` posée DANS un autre dépôt qui
//     l'ignore : le dossier personnel du propriétaire est un dépôt sur sa
//     machine, et un paquet de relecture s'extrait dessous).
// Un dossier neuf du dépôt, rien encore ajouté, n'est ni l'un ni l'autre : git
// en montre les fichiers (`--others`), ils sont lus. Un dossier vraiment vide
// n'a rien à cacher : liste vide.
//
// Ce que la règle ne voit pas : une copie posée dans un autre dépôt qui n'en
// cache qu'une PARTIE (une règle `*.js` du dépôt extérieur). Rien, dans ce que
// git rend, ne distingue cette règle de celle du dépôt qui cache un build ;
// il faudrait savoir quel dépôt le scan visait, et les scanners ne reçoivent
// qu'un dossier. Les gardes du dépôt tournent dans un clone ou un worktree.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
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
  if (!existsSync(root)) {
    throw new Error(
      `source_files_dir_missing: ${root} does not exist: a scan of it would read nothing and pass ` +
        '(a renamed package, a wrong root?)',
    );
  }
  const files = [
    ...new Set(
      gitIn(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
        .split('\0')
        .filter(Boolean)
        .map((rel) => join(root, rel))
        .filter((f) => existsSync(f)),
    ),
  ].sort();
  if (files.length === 0 && holdsAFile(root)) {
    throw new Error(
      `source_files_none_visible: ${root} holds files, and git shows none of them as source ` +
        '(all ignored): a scan of it would read nothing and pass. An ignored folder, or a copy ' +
        'without its own .git inside a repository that ignores it? Run the scanners from a clone or a worktree',
    );
  }
  return files;
}

/** Un fichier, à n'importe quelle profondeur sous `dir` ; s'arrête au premier. */
function holdsAFile(dir: string): boolean {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) return true;
    if (holdsAFile(join(dir, e.name))) return true;
  }
  return false;
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
