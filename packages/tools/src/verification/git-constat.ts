// verification/git-constat.ts — CE QUE GIT A VU, avant et après le run.
//
// Issue #199, décision de Quentin du 18/09. Depuis #102/#196, les écritures
// d'un run sont constatées sur le disque, mais SEULEMENT sur les fichiers que
// quelqu'un a nommés : ceux qu'un outil de Nodal vise (`observed.ts`), ceux
// qu'un harnais rapporte (`harness.ts`). Ce qu'un `run_command` écrit sans le
// dire — un `npm install`, un générateur, un script qui écrit dix fichiers —
// n'est constaté nulle part, et le dossier du shell ne crédite plus rien.
//
// Quand le dossier du projet est un DÉPÔT GIT, il existe une réponse exacte et
// gratuite à cette question : `git status --porcelain` avant le run, le même
// après, et le DELTA est la liste des fichiers que ce run a écrits. Aucun
// jeton dépensé, aucune écriture — git n'est lu que pour ce qu'il sait déjà.
//
// ═══ LES BORNES, ÉCRITES ICI PARCE QU'ELLES NE DOIVENT PAS ÊTRE TUES ═══
//
//  1. LES CHEMINS IGNORÉS NE COMPTENT PAS. `git status --porcelain` ne liste
//     pas ce que `.gitignore` couvre, et rien ici ne passe `--ignored`. Un
//     `node_modules/` réinstallé, un `dist/` reconstruit : ce ne sont pas des
//     livrables, ils ne paraissent pas. C'est un CHOIX, pas un oubli — la
//     limite de #196 (ce qui n'est pas nommé n'est pas constaté) devient ici
//     « ce que le dépôt ne suit pas n'est pas livré ».
//
//  2. DEUX JOBS SUR LE MÊME PROJET SE VOIENT ATTRIBUER LES FICHIERS L'UN DE
//     L'AUTRE. `git status` parle du dossier, pas du processus : si un autre
//     job écrit dans le même dépôt pendant ce run, son fichier tombe dans ce
//     delta. Le delta AVANT/APRÈS réduit la fenêtre à la durée d'un appel —
//     c'est tout ce qu'il peut faire, et l'issue #101 (staleness) reste
//     ouverte pour le reste.
//
//  3. UN PROJET QUI N'EST PAS UN DÉPÔT RETOMBE SUR LE DISQUE, ET LE DIT. Pas
//     de repli silencieux (invariant #4) : le constat porte `constatedBy`, la
//     donnée du run le garde, et le bloc Files l'écrit en un mot.
//
//  4. UN ARBRE TROP SALE FAIT DÉCLINER LE CONSTAT. Au-delà de
//     `MAX_STATUS_ENTRIES` lignes de statut, les empreintes coûteraient une
//     lecture complète de tout l'arbre sale deux fois par commande. Le module
//     décline alors ce dépôt — il retombe sur le disque et le dit par un code
//     de journal, plutôt que de rendre un constat approximatif que personne
//     n'aurait su lire.
//
//  5. UNE LIGNE QUI DISPARAÎT DU STATUT EST RELUE SUR LE DISQUE, jamais
//     déduite. Deux gestes très différents vident une ligne de `git status` :
//     un `git commit`, qui ne touche pas un octet du disque, et un
//     `git checkout -- <fichier>`, qui REMET son contenu d'avant — une
//     écriture, et de celles qui comptent. Le statut ne les distingue pas :
//     les deux ont simplement disparu. La relecture du contenu, elle, les
//     sépare — et c'est elle qui fait entrer le second dans le constat sans y
//     faire entrer le premier. Sans elle, une restauration ne se voyait nulle
//     part.
//
// ═══ POURQUOI DES EMPREINTES, ET PAS SEULEMENT LES CODES DE STATUT ═══
//
// Un fichier déjà modifié AVANT le run et modifié ENCORE pendant porte le même
// code ` M` des deux côtés : le delta des seuls codes ne le verrait pas. Les
// empreintes sont donc prises sur les fichiers que le statut nomme — ceux-là
// seuls, jamais l'arbre entier — avec `fingerprint` d'`observed.ts`, la même
// que le constat des cibles nommées. Deux empreintes différentes valent une
// écriture ; deux empreintes identiques ne valent rien, même si le code de
// statut a changé (un `git add` déplace la lettre d'une colonne à l'autre sans
// rien écrire).

import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { normalizePath } from '@nodal-agents/shared';
import type { ConstatedChangeKind, ConstatedWrite } from '@nodal-agents/shared';
import { fingerprint, type FileFingerprint } from './observed';

const run = promisify(execFile);

/** Une sonde qui pend ne doit pas tenir un appel d'outil. */
const GIT_TIMEOUT_MS = 5_000;

/**
 * Au-delà, le constat par git décline (borne nº 4 ci-dessus). Mille lignes de
 * statut, c'est déjà un arbre que personne ne relit à l'œil ; en dessous, le
 * prix des empreintes est celui de quelques fichiers.
 */
export const MAX_STATUS_ENTRIES = 1000;

/** Une ligne de statut, avec ce que le disque en dit. */
export interface GitStatusEntry {
  /**
   * Les deux lettres de `git status --porcelain`, ou `null` pour une ligne qui
   * a DISPARU du statut d'après et qu'on a relue sur le disque (borne nº 5).
   */
  readonly status: string | null;
  readonly fingerprint: FileFingerprint;
  /** Le nom d'avant, quand git annonce un renommage. */
  readonly renamedFrom?: string;
}

/** L'état d'un dépôt à un instant : chemin ABSOLU → ligne de statut. */
export interface RepoSnapshot {
  /** Racine du dépôt, absolue et slash-normalisée. */
  readonly root: string;
  readonly entries: ReadonlyMap<string, GitStatusEntry>;
}

/** Ce que le seam garde entre l'avant et l'après d'un appel. */
export type GitConstatBefore = readonly RepoSnapshot[];

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch {
    // Pas un dépôt, pas de git sur le PATH, délai dépassé : aucune réponse
    // utilisable. L'appelant retombe sur le disque et le DIT.
    return null;
  }
}

/** La racine du dépôt qui contient `dir`, ou `null` s'il n'y en a pas. */
export async function repoRootOf(dir: string): Promise<string | null> {
  const out = await git(dir, ['rev-parse', '--show-toplevel']);
  const root = out?.trim();
  return root ? normalizePath(root) : null;
}

/**
 * Le genre d'une écriture, lu dans les deux lettres de `git status`.
 *
 * L'ORDRE DES TESTS EST LE FOND. `AD` (ajouté à l'index, puis supprimé du
 * disque) est une SUPPRESSION : le fichier n'est pas là. Tester `A` d'abord en
 * ferait un ajout, et le bloc Files annoncerait un fichier livré qui n'existe
 * pas.
 */
export function kindOfStatus(status: string | null): ConstatedChangeKind {
  if (status === null) return 'modified';
  const x = status[0] ?? ' ';
  const y = status[1] ?? ' ';
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'R' || y === 'R') return 'renamed';
  if (x === 'A' || status === '??') return 'added';
  return 'modified';
}

/**
 * Les lignes de `git status --porcelain -z -uall`, telles quelles.
 *
 * `-z` plutôt que la sortie lisible : sans lui, git CITE les chemins qui
 * contiennent un espace, un accent ou un guillemet, avec des échappements en
 * octal qu'il faudrait défaire — et un chemin mal défait est un fichier
 * attribué au mauvais nom. `-uall` liste les fichiers d'un nouveau dossier un
 * par un, au lieu du dossier seul : c'est la liste des fichiers livrés qu'on
 * cherche, pas celle des dossiers touchés.
 */
export function parsePorcelainZ(
  stdout: string,
): ReadonlyArray<{ status: string; path: string; renamedFrom?: string }> {
  const champs = stdout.split('\0');
  const out: Array<{ status: string; path: string; renamedFrom?: string }> = [];
  for (let i = 0; i < champs.length; i++) {
    const champ = champs[i];
    if (champ === undefined || champ === '') continue;
    // `XY <chemin>` — exactement un espace entre les deux lettres et le chemin.
    const status = champ.slice(0, 2);
    const path = champ.slice(3);
    if (path === '') continue;
    if (status[0] === 'R' || status[0] === 'C') {
      // Un renommage occupe DEUX champs : la destination, puis l'origine.
      const from = champs[i + 1];
      i += 1;
      out.push(from === undefined ? { status, path } : { status, path, renamedFrom: from });
      continue;
    }
    out.push({ status, path });
  }
  return out;
}

/**
 * L'état d'un dépôt : son statut, et l'empreinte de chaque fichier nommé.
 *
 * Rend `null` quand git n'a pas répondu, ou quand l'arbre est trop sale pour
 * que le constat vaille son prix (borne nº 4) — dans les deux cas le run
 * retombe sur le disque, et la raison est dite par un code.
 */
export async function snapshotRepo(root: string): Promise<RepoSnapshot | null> {
  const stdout = await git(root, ['status', '--porcelain', '-z', '--untracked-files=all']);
  if (stdout === null) {
    console.warn(`[verification] GIT_CONSTAT_STATUS_FAILED root=${root}`);
    return null;
  }
  const lignes = parsePorcelainZ(stdout);
  if (lignes.length > MAX_STATUS_ENTRIES) {
    console.warn(
      `[verification] GIT_CONSTAT_TREE_TOO_DIRTY root=${root} entries=${lignes.length} ` +
        `max=${MAX_STATUS_ENTRIES}`,
    );
    return null;
  }
  const entries = new Map<string, GitStatusEntry>();
  for (const ligne of lignes) {
    const absolu = `${root}/${normalizePath(ligne.path)}`;
    entries.set(absolu, {
      status: ligne.status,
      fingerprint: await fingerprint(absolu),
      ...(ligne.renamedFrom !== undefined
        ? { renamedFrom: `${root}/${normalizePath(ligne.renamedFrom)}` }
        : {}),
    });
  }
  return { root, entries };
}

/** Deux empreintes du même fichier disent-elles la même chose ? */
function memeEmpreinte(a: FileFingerprint, b: FileFingerprint): boolean | 'indecis' {
  if (a.kind === 'unreadable' || b.kind === 'unreadable') {
    // La seule chose qui reste est la taille, quand `stat` a répondu des deux
    // côtés. Même règle qu'`observed.ts` : à défaut, rien n'est constaté et la
    // ligne est DITE, pas devinée dans un sens ou dans l'autre.
    const ta = a.kind === 'absent' ? null : a.size;
    const tb = b.kind === 'absent' ? null : b.size;
    if (ta !== null && tb !== null) return ta === tb;
    return 'indecis';
  }
  if (a.kind === 'absent' && b.kind === 'absent') return true;
  if (a.kind === 'file' && b.kind === 'file') return a.size === b.size && a.sha256 === b.sha256;
  return false;
}

/** Ce qu'un delta a vu, et ce sur quoi il n'a pas pu se prononcer. */
export interface GitDelta {
  readonly writes: readonly ConstatedWrite[];
  /** Les chemins dont une des deux empreintes n'a pas pu être lue. Dits, jamais crédités. */
  readonly indecis: readonly string[];
}

/**
 * Le DELTA — la liste des fichiers que ce run a écrits, d'après git.
 *
 * Pure : aucune lecture, aucun spawn. L'appelant lui donne les deux états, y
 * compris les relectures de la borne nº 5, et elle compare. C'est la fonction
 * que les tests mutent.
 */
export function deltaConstat(before: RepoSnapshot, after: RepoSnapshot): GitDelta {
  const writes: ConstatedWrite[] = [];
  const indecis: string[] = [];
  for (const [path, apres] of after.entries) {
    const avant = before.entries.get(path);
    if (avant === undefined) {
      // Un chemin que le statut d'avant ne portait pas : soit il était propre
      // (donc le run l'a écrit), soit il n'existait pas (le run l'a créé).
      writes.push(ligne(path, apres));
      continue;
    }
    const meme = memeEmpreinte(avant.fingerprint, apres.fingerprint);
    if (meme === 'indecis') {
      indecis.push(path);
      continue;
    }
    // Empreinte identique = rien n'a été écrit, même si la lettre du statut a
    // bougé : `git add` déplace `??` en `A ` sans toucher au fichier.
    if (!meme) writes.push(ligne(path, apres));
  }
  return { writes, indecis };
}

function ligne(path: string, entree: GitStatusEntry): ConstatedWrite {
  const kind = entree.status === null ? kindApresRelecture(entree) : kindOfStatus(entree.status);
  return {
    path,
    kind,
    ...(entree.renamedFrom !== undefined ? { renamedFrom: entree.renamedFrom } : {}),
  };
}

/**
 * Le genre d'une ligne RELUE sur le disque (borne nº 5) : le statut ne dit plus
 * rien d'elle, seul le disque parle. Le fichier n'est plus là ⇒ supprimé ;
 * il est là et son contenu a bougé ⇒ modifié.
 */
function kindApresRelecture(entree: GitStatusEntry): ConstatedChangeKind {
  return entree.fingerprint.kind === 'absent' ? 'deleted' : 'modified';
}

/**
 * `chemin` est-il `racine`, ou sous elle ? Comparaison en casse repliée : sous
 * Windows le même dossier s'écrit `D:/Apps/x` et `d:/apps/x`.
 */
function sousOuEgal(chemin: string, racine: string): boolean {
  const c = normalizePath(chemin).toLowerCase();
  const r = normalizePath(racine).toLowerCase();
  return c === r || c.startsWith(`${r}/`);
}

/**
 * Le chemin RÉEL d'un dossier, pour que la comparaison de périmètre porte sur
 * le même objet des deux côtés.
 *
 * TROUVÉ PAR LA CI WINDOWS, PREMIER PASSAGE DE LA PR. `git rev-parse` rend
 * toujours la forme longue et suivie (`C:/Users/runneradmin/…`), alors que le
 * dossier visé peut arriver en forme courte 8.3 (`C:/Users/RUNNER~1/…`, ce que
 * donne `os.tmpdir()` sur un agent GitHub) ou à travers une jonction. Les deux
 * désignent le même dossier et ne se ressemblent pas : la garde de périmètre
 * refusait alors le dépôt du run lui-même, et tout le constat par git tombait
 * silencieusement sur le repli disque.
 *
 * Rend le chemin d'entrée quand il n'existe pas encore (un dossier attaché
 * d'avance) : à défaut de mieux, la comparaison de texte, qui est ce qu'on
 * avait.
 */
async function cheminReel(dir: string): Promise<string> {
  try {
    return normalizePath(await realpath(normalizePath(dir)));
  } catch {
    return normalizePath(dir);
  }
}

/**
 * L'état d'AVANT, pris sur les dossiers que l'outil vise.
 *
 * Un dossier est réduit à la RACINE de son dépôt : un `cwd` trois niveaux plus
 * bas et son dépôt sont le même état, et le prendre deux fois ferait compter
 * chaque écriture deux fois. Les dossiers qui ne sont dans aucun dépôt ne
 * rendent rien : ce run sera constaté sur le disque, et le dira.
 *
 * ═══ LE DÉPÔT NE REMONTE JAMAIS AU-DESSUS DU PÉRIMÈTRE DU RUN ═══
 *
 * `git rev-parse --show-toplevel` REMONTE : lancé dans un dossier temporaire
 * sous `C:/Users/<qui>`, il rend `C:/Users/<qui>` dès que cette maison est
 * elle-même un dépôt — ce qui arrive (dotfiles versionnés), et le premier
 * passage de ce test l'a trouvé. Le constat aurait alors porté sur TOUT le
 * profil de la personne : chaque fichier qu'un autre programme y touche serait
 * devenu un fichier « livré » par le run.
 *
 * La racine n'est donc retenue que si elle EST l'un des dossiers visés, ou
 * qu'elle tombe sous l'un d'eux. Un projet posé dans un monorepo dont il n'est
 * pas la racine retombe ainsi sur le constat disque, et le dit : c'est plus
 * pauvre, et c'est le seul repli honnête — Nodal constate le projet qu'on lui
 * a donné, pas la machine autour.
 *
 * Ne lève jamais. Une panne de git n'est pas une panne d'écriture.
 */
export async function snapshotGitAvant(dirs: readonly string[]): Promise<GitConstatBefore> {
  const racines = new Map<string, RepoSnapshot>();
  const vus = new Set<string>();
  // Le périmètre est comparé sur les chemins RÉELS : git rend la forme longue
  // et suivie, le dossier visé peut arriver en 8.3 ou à travers une jonction.
  const perimetre = await Promise.all(dirs.map((d) => cheminReel(d)));
  for (const dir of perimetre) {
    if (vus.has(dir)) continue;
    vus.add(dir);
    const root = await repoRootOf(dir);
    if (root === null || racines.has(root)) continue;
    const rootReel = await cheminReel(root);
    if (!perimetre.some((d) => sousOuEgal(rootReel, d))) {
      console.warn(`[verification] GIT_CONSTAT_ROOT_ABOVE_SCOPE root=${root} dir=${dir}`);
      continue;
    }
    const snap = await snapshotRepo(root);
    if (snap !== null) racines.set(root, snap);
  }
  return [...racines.values()];
}

/** Ce que le constat par git a rendu pour un run. */
export interface GitConstat {
  /** Les fichiers écrits, tous dépôts confondus. */
  readonly writes: readonly ConstatedWrite[];
  /** Les racines réellement constatées — vide = aucun dépôt, donc constat disque. */
  readonly roots: readonly string[];
  /** Les chemins sur lesquels une empreinte n'a pas pu se lire. */
  readonly indecis: readonly string[];
}

/**
 * L'état d'APRÈS, et le delta.
 *
 * LA RELECTURE DE LA BORNE Nº 5 SE FAIT ICI : toute ligne du statut d'avant
 * absente du statut d'après est re-empreintée sur le disque et rentrée dans
 * l'état d'après avec `status: null`. C'est ce qui sépare les deux gestes qui
 * vident une ligne de statut — un `git commit`, qui n'écrit rien, et un
 * `git checkout -- <fichier>`, qui réécrit le fichier. Sans elle, le second
 * ne se voyait nulle part.
 */
export async function constatedGitWrites(before: GitConstatBefore): Promise<GitConstat> {
  const writes: ConstatedWrite[] = [];
  const roots: string[] = [];
  const indecis: string[] = [];
  for (const avant of before) {
    const apres = await snapshotRepo(avant.root);
    if (apres === null) continue;
    const entries = new Map<string, GitStatusEntry>(apres.entries);
    for (const path of avant.entries.keys()) {
      if (entries.has(path)) continue;
      entries.set(path, { status: null, fingerprint: await fingerprint(path) });
    }
    const delta = deltaConstat(avant, { root: apres.root, entries });
    roots.push(avant.root);
    writes.push(...delta.writes);
    indecis.push(...delta.indecis);
  }
  if (indecis.length > 0) {
    console.warn(`[verification] GIT_CONSTAT_UNREADABLE paths=${indecis.join(',')}`);
  }
  return { writes, roots, indecis };
}
