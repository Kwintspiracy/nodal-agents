// project-git.ts — POSER GIT DANS UN DOSSIER DE PROJET, quand on le demande.
//
// Issue #200, décision du propriétaire du 19/09. Le constat par git (#199)
// s'active de lui-même dès qu'un projet est un dépôt : il voit ce qu'un shell
// écrit sans le nommer, pour zéro jeton. Quelqu'un qui démarre un projet
// depuis Telegram ou depuis le chat de Nodal n'a pas git, et n'aurait donc
// jamais le meilleur constat que le produit sache faire.
//
// ═══ CE QUE CE MODULE NE FAIT PAS, ET C'EST L'ESSENTIEL ═══
//
// Il ne pose RIEN de lui-même. Il n'est appelé qu'au moment où le propriétaire
// coche la case ou bascule l'interrupteur — jamais à l'ouverture d'un écran,
// jamais au premier run, jamais « puisque le projet vient d'être créé ». Un
// dossier de quelqu'un d'autre n'est pas un endroit où l'on écrit sans qu'il
// l'ait demandé, et `git init` écrit : il crée `.git/`, et ce module y ajoute
// un `.gitignore` quand il n'y en a pas.
//
// Il ne RETOUCHE jamais un dépôt existant. L'option dit « je veux que ce
// dossier soit versionné », pas « recommence » : un `.git` déjà là est le bon
// état, et le résultat le dit (`already`) au lieu de faire semblant d'avoir
// agi. Un `.gitignore` déjà écrit n'est pas réécrit non plus — c'est le choix
// de quelqu'un, pas un défaut à corriger.
//
// Il ne commite RIEN, ne crée aucune branche nommée, ne pose aucun remote. Un
// dépôt vide suffit au constat, et chacun de ces gestes serait une décision
// prise à la place de la personne.

import { access, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizePath } from '@nodal-agents/shared';
// LA MÊME résolution que le constat par git (#227), pas une copie : c'est le
// même `git`, lancé avec le même `cwd`, donc la même question. Deux copies
// auraient divergé au premier correctif porté d'un seul côté (revue C de la
// PR #244, constat bloquant).
import { resolveGitBinary } from '@nodal-agents/tools/git-binary';

const run = promisify(execFile);

/** Une commande git qui pend ne doit pas tenir un clic. */
const GIT_TIMEOUT_MS = 10_000;

/**
 * Le `.gitignore` MINIMAL, et il l'est exprès.
 *
 * Trois lignes, celles qui valent pour n'importe quelle pile et qu'on regrette
 * toujours d'avoir oubliées : les dépendances, la sortie de build, les
 * secrets. Deviner la pile pour en écrire plus serait une devinette de plus à
 * nommer, et un fichier qu'il faudrait corriger à la main.
 *
 * `.env*` couvre `.env`, `.env.local`, `.env.production` : un secret poussé
 * est un secret brûlé, et c'est la seule ligne ici dont l'oubli ne se rattrape
 * pas.
 */
export const GITIGNORE_MINIMAL = 'node_modules/\ndist/\n.env*\n';

/** Ce que la pose de git a donné. Aucune issue muette. */
export type GitInitOutcome =
  /** Le dépôt a été créé par Nodal, à l'instant. */
  | { readonly kind: 'initialised'; readonly gitignoreWritten: boolean }
  /** Le dossier était DÉJÀ un dépôt : rien n'a été touché. */
  | { readonly kind: 'already' }
  /** git a refusé, ou n'est pas là. Dit, jamais avalé. */
  | { readonly kind: 'failed'; readonly reason: string };

async function existe(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pose git dans `dir`, si et seulement si ce dossier n'est pas déjà un dépôt.
 *
 * LA QUESTION EST « CE DOSSIER-CI », PAS « SUIS-JE DANS UN DÉPÔT ». On teste
 * la présence de `.git` À LA RACINE, et non `git rev-parse`, qui REMONTE : un
 * projet posé sous un dossier personnel lui-même versionné se serait vu
 * répondre « déjà un dépôt » et n'aurait jamais eu le sien. C'est la symétrique
 * de la borne que `git-constat.ts` pose sur la racine retenue, et elle vient du
 * même piège.
 *
 * Ne lève jamais : une panne de git n'est pas une panne de l'écran qui
 * l'appelle. Elle se rend, et l'appelant la dit.
 */
export async function initGitRepository(dir: string): Promise<GitInitOutcome> {
  const cwd = normalizePath(dir);
  if (await existe(`${cwd}/.git`)) return { kind: 'already' };

  // Le chemin ABSOLU, jamais le nom nu : `cwd` est le dossier d'un projet, donc
  // un dossier où des agents écrivent, et le nom nu le ferait entrer dans la
  // recherche du programme. Sans git sur le PATH, on ne pose rien et on le dit.
  const binaire = await resolveGitBinary();
  if (binaire === null) {
    console.error(`[projects] GIT_INIT_NO_GIT_ON_PATH path=${cwd}`);
    return { kind: 'failed', reason: 'git is not on this machine’s PATH' };
  }

  try {
    await run(binaire, ['init'], { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[projects] GIT_INIT_FAILED path=${cwd}`, err);
    return { kind: 'failed', reason };
  }

  // Le `.gitignore` seulement s'il n'y en a pas : celui de quelqu'un d'autre
  // n'est pas un défaut à corriger. Son échec n'annule PAS la pose du dépôt —
  // le dépôt est là, et c'est lui qui porte le constat.
  const chemin = `${cwd}/.gitignore`;
  let gitignoreWritten = false;
  if (!(await existe(chemin))) {
    try {
      await writeFile(chemin, GITIGNORE_MINIMAL, 'utf8');
      gitignoreWritten = true;
    } catch (err) {
      console.warn(`[projects] GITIGNORE_WRITE_FAILED path=${chemin}`, err);
    }
  }
  return { kind: 'initialised', gitignoreWritten };
}
