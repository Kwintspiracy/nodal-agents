// checkpoints.ts — transparent snapshots of a workspace, taken before an agent
// is allowed to change it.
//
// ## Why
//
// A `mode: "write"` run that goes wrong has no undo. The owner's only recourse
// is their own git history — if they happened to have committed, in a workspace
// that happens to be a repository. Most agent workspaces are neither. That gap
// is what decides whether someone dares let an agent write at all, which makes
// it worth more than the sum of its lines.
//
// Hermes solves it with a shadow git store (`tools/checkpoint_manager.py`) and
// the design here follows it, for reasons that survive inspection:
//
//   - **git, not a file copy.** Content-addressed storage deduplicates across
//     turns and across projects; a hundred snapshots of a repo cost roughly one
//     copy plus the deltas. Rolling back is a checkout, not a merge.
//   - **a SHADOW store, never the workspace's own `.git`.** The owner's history
//     is theirs. We never add a commit to it, never touch their index, never
//     move their HEAD. The cost is duplicated object storage on a workspace
//     that is already a repository; the benefit is that a checkpoint can never
//     corrupt something the user cares about.
//   - **not a tool.** The model never sees this, cannot call it, cannot skip
//     it. Anything the model can decide not to do is not a safety net.
//
// ## What it deliberately does not do
//
// It does not restore automatically. Deciding that a run went wrong is a human
// judgement, and an agent that could roll itself back could also roll back the
// evidence.

import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdir, open, readdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { createInflate } from 'node:zlib';

import { resolveGitBinary } from '@nodal-agents/shared/git-binary';

import {
  CheckpointError,
  checkpointFailureCode,
  isCheckpointError,
  measureWorkspace,
  SKIPPED_DIRS,
  SKIPPED_FILE_SUFFIXES,
  type CheckpointFailureCause,
  type CheckpointOperation,
} from './failure';

const run = promisify(execFile);

// ─── Qui lance git ───────────────────────────────────────────────────────────
//
// Tout git d'ici a le WORKSPACE pour arbre de travail (gitEnv). Il en lit donc
// les sous-dépôts imbriqués : `add -A` et `status` lancent un git enfant DANS
// chacun pour savoir s'il a bougé, qui lit SA config — mesuré le 16/10, un
// `core.fsmonitor` planté dans un sous-dépôt s'exécute sur `snapshot`, sur le
// statut figé et sur `restoreCheckpoint`. Le `GIT_DIR` externe protège la
// config du dépôt racine, pas celle-là.
//
// DEUX ENDROITS, et une règle (#628, passe 5) : AUCUN processus qui lit une
// config contrôlée par le workspace n'a le droit d'écrire le magasin.
//
//   - Un git qui lit l'ARBRE DE TRAVAIL (`add`, `write-tree` après `add`,
//     `status`, `checkout`, un diff contre l'arbre) tourne avec les programmes
//     de l'appelant — dans le bac à sable quand le runner passe
//     `openNodalPrograms` (@nodal-agents/sandbox). Le magasin y est en LECTURE
//     seule : ses objets neufs vont dans un dossier JETABLE (`Scratch` :
//     `GIT_OBJECT_DIRECTORY`, le magasin en alternate), son index dans une
//     copie jetable. Ce qu'une commande plantée y ferait ne touche que le
//     jetable et le workspace, que le job écrit déjà.
//   - Un git qui ne lit QUE le magasin (`rev-parse`, `commit-tree`,
//     `update-ref`, `log`, `ls-tree`, `cat-file`) tourne sur l'HÔTE, `GIT_DIR`
//     seul, sans arbre de travail : il ne lit que la config que Nodal écrit. Lui
//     seul écrit le magasin, après avoir importé et VÉRIFIÉ chaque objet du
//     jetable (`importObjects`).
//
// La forme des programmes est celle du `ProgramRunner` du bac à sable, par
// structure : ce paquet n'en dépend pas (voir index.ts). Sans programmes
// donnés, le git de l'arbre tourne sur l'hôte, par le même chemin.

/** Ce qu'un lancement de git reçoit. */
export interface CheckpointProgramOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeout?: number;
  readonly maxBuffer?: number;
  readonly writableRoots: readonly string[];
  readonly readableRoots: readonly string[];
}

/** Un git lancé en flux. */
export interface CheckpointProgramChild {
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(): void;
  readonly closed: Promise<{ code: number | null }>;
}

/** Comment lancer git : `execFile` et `spawn`, sur l'hôte ou dans le bac à sable. */
export interface CheckpointPrograms {
  execFile(
    file: string,
    args: readonly string[],
    opts: CheckpointProgramOptions,
  ): Promise<{ stdout: string; stderr: string }>;
  spawn(
    file: string,
    args: readonly string[],
    opts: Omit<CheckpointProgramOptions, 'timeout' | 'maxBuffer'>,
  ): Promise<CheckpointProgramChild>;
}

/** Git sur l'hôte : `execFile` / `spawn` de Node, exactement comme avant. */
const hostGit: CheckpointPrograms = {
  execFile: (file, args, opts) =>
    run(file, [...args], {
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
      ...(opts.maxBuffer !== undefined ? { maxBuffer: opts.maxBuffer } : {}),
      windowsHide: true,
      env: opts.env,
    }),
  spawn: (file, args, opts) =>
    new Promise((resolve, reject) => {
      const child = spawn(file, [...args], { windowsHide: true, env: opts.env });
      const closed = new Promise<{ code: number | null }>((r) =>
        child.on('close', (code) => r({ code })),
      );
      child.once('error', reject);
      child.once('spawn', () => {
        child.off('error', reject);
        child.on('error', () => undefined); // une erreur tardive finit par `close`
        resolve({ stdout: child.stdout, stderr: child.stderr, kill: () => child.kill(), closed });
      });
    }),
};

/** Les programmes de l'opération en cours (posés par l'appel exporté). */
const programsOfOperation = new AsyncLocalStorage<CheckpointPrograms>();

function programs(): CheckpointPrograms {
  return programsOfOperation.getStore() ?? hostGit;
}

/** Fait `fn` avec ces programmes ; sans programmes donnés, garde ceux d'au-dessus. */
function withPrograms<T>(given: CheckpointPrograms | undefined, fn: () => Promise<T>): Promise<T> {
  return given ? programsOfOperation.run(given, fn) : fn();
}

/** Le dossier jetable d'un git qui lit l'arbre de travail. */
interface Scratch {
  readonly dir: string;
  /** `GIT_OBJECT_DIRECTORY` : là où ce git écrit ses objets neufs. */
  readonly objects: string;
  /** La copie jetable de l'index du workspace. */
  readonly index: string;
}

/** Où tourne un git : contre le magasin seul (hôte), ou sur l'arbre de travail. */
export type Where =
  | { readonly kind: 'store' }
  | { readonly kind: 'worktree'; readonly scratch: Scratch };

const STORE: Where = { kind: 'store' };
const onWorktree = (scratch: Scratch): Where => ({ kind: 'worktree', scratch });

/**
 * Ce que le git de l'arbre peut écrire : le workspace (son arbre — même pour
 * lire, MXC refuse un `chdir` dans un dossier en lecture seule) et SON jetable.
 * Le magasin : en lecture seulement. Le workspace d'abord : c'est le dossier de
 * départ dans le conteneur.
 */
function worktreeRoots(
  store: string,
  workspace: string,
  scratch: Scratch,
): Pick<CheckpointProgramOptions, 'writableRoots' | 'readableRoots'> {
  return { writableRoots: [workspace, scratch.dir], readableRoots: [store] };
}

/** Ouvre un jetable sous le magasin ; `seed` y copie l'index du workspace. */
async function openScratch(store: string, workspace: string, seed: boolean): Promise<Scratch> {
  const dir = join(store, 'scratch', randomBytes(8).toString('hex'));
  const objects = join(dir, 'objects');
  await mkdir(objects, { recursive: true });
  const index = join(dir, 'index');
  const source = join(store, 'indexes', workspaceKey(workspace));
  if (seed && existsSync(source)) await copyIndex(source, index);
  return { dir, objects, index };
}

/**
 * Copie un index de git en gardant ce que git lit dans sa DATE.
 *
 * Git ne relit le contenu d'une entrée que si elle est « racy » : datée au plus
 * tard de l'écriture de l'index (racy-git.txt). Sinon il croit la date et la
 * taille. La date d'un index fait donc partie de ce qu'il dit : une copie datée
 * de maintenant rend « propre » une réécriture de même taille faite dans le
 * même tic que l'original, qu'un instantané manque alors, et qu'une
 * restauration ne réécrit pas. `copyFile` ne la garde que sous Windows
 * (CopyFileW) ; ailleurs libuv date la copie de maintenant (CI rouge sur
 * 71fb7bca). Seule copie d'index du paquet : le jetable de `openScratch` et la
 * copie figée de `freezeSnapshotIndex` passent par elle. Le retour d'un index
 * jetable (`keepScratchIndex`) est un renommage, qui garde la date que git a
 * donnée à SON écriture.
 *
 * Une seule lecture (revue A de #591, passe 2) : contenu et date viennent de la
 * même poignée, ouverte par libuv, qui partage lecture, écriture ET
 * suppression. Git et `keepScratchIndex` remplacent un index par renommage : la
 * poignée lit l'ancien fichier en entier, jamais un index à moitié écrit, et le
 * renommage d'un autre job passe même sous Windows, où CopyFileW tenait la
 * source ouverte sans partage de suppression.
 *
 * La date est arrondie VERS LE BAS à la milliseconde, moins une : `utimes`
 * passe par des secondes en virgule flottante, dont l'erreur (de l'ordre du
 * dixième de microseconde à notre époque) pourrait dater la copie un rien
 * APRÈS l'original. Une copie datée un rien plus tôt fait juger racy un fichier
 * de plus, donc relu ; jamais un de moins, donc manqué.
 */
async function copyIndex(source: string, dest: string): Promise<void> {
  const lu = await open(source, 'r');
  let contenu: Buffer;
  let date: number;
  try {
    date = (await lu.stat()).mtimeMs;
    contenu = await lu.readFile();
  } finally {
    await lu.close();
  }
  await writeFile(dest, contenu);
  const secondes = (Math.floor(date) - 1) / 1000;
  await utimes(dest, secondes, secondes);
}

async function closeScratch(scratch: Scratch): Promise<void> {
  await rm(scratch.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
    () => undefined,
  );
}

/** L'index du jetable devient celui du workspace (renommage, atomique). */
async function keepScratchIndex(store: string, workspace: string, scratch: Scratch): Promise<void> {
  if (!existsSync(scratch.index)) return;
  await rename(scratch.index, join(store, 'indexes', workspaceKey(workspace)));
}

/**
 * Importe dans le magasin les objets que le git de l'arbre a écrits dans le
 * jetable — sur l'HÔTE, chacun VÉRIFIÉ : un objet libre doit avoir le nom de
 * son contenu (SHA-1 de `type taille\0contenu`), un paquet doit passer
 * `git verify-pack`. Rien d'existant n'est remplacé. Ce que le jetable aurait
 * reçu d'une commande plantée ne peut donc qu'AJOUTER des objets exacts.
 */
async function importObjects(store: string, scratch: Scratch): Promise<void> {
  const target = join(store, 'store', 'objects');
  for (const dir of await readdir(scratch.objects).catch(() => [] as string[])) {
    if (/^[0-9a-f]{2}$/.test(dir)) {
      for (const name of await readdir(join(scratch.objects, dir))) {
        if (!/^[0-9a-f]{38}$/.test(name)) continue;
        const src = join(scratch.objects, dir, name);
        const got = await looseObjectId(src);
        if (got !== dir + name) {
          throw new Error(`CHECKPOINT_FOREIGN_OBJECT: ${dir}${name} holds ${got}`);
        }
        const dst = join(target, dir, name);
        if (existsSync(dst)) continue;
        await mkdir(join(target, dir), { recursive: true });
        await moveFile(src, dst);
      }
    } else if (dir === 'pack') {
      const packDir = join(scratch.objects, 'pack');
      for (const name of await readdir(packDir)) {
        if (!name.endsWith('.idx')) continue;
        const base = name.slice(0, -'.idx'.length);
        await run(await gitBinary(), ['verify-pack', join(packDir, name)], {
          timeout: storeTimeoutMs(),
          windowsHide: true,
          env: storeEnv(store),
        });
        await mkdir(join(target, 'pack'), { recursive: true });
        for (const ext of ['.pack', '.idx']) {
          const dst = join(target, 'pack', base + ext);
          if (!existsSync(dst)) await moveFile(join(packDir, base + ext), dst);
        }
      }
    }
  }
}

/** Le nom qu'un objet libre DEVRAIT porter : SHA-1 de son contenu décompressé. */
function looseObjectId(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha1');
    createReadStream(path)
      .on('error', reject)
      .pipe(createInflate())
      .on('error', reject)
      .on('data', (c: Buffer) => hash.update(c))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** Renomme, ou copie puis supprime si le renommage traverse un volume. */
async function moveFile(src: string, dst: string): Promise<void> {
  try {
    await rename(src, dst);
  } catch {
    await copyFile(src, dst);
    await rm(src, { force: true });
  }
}

/** A snapshot that hangs must not hold a tool call. */
const GIT_TIMEOUT_MS = 30_000;

/**
 * La borne de temps de TOUTE commande git du magasin, surchargeable — issue
 * #245, étendue aux lectures par la revue #262 passe 2 (une lecture qui ne
 * répond pas doit le dire, donc elle doit d'abord pouvoir être bornée).
 *
 * Deux raisons, et aucune n'est le confort :
 *
 *   - les tests ont besoin d'un dépassement RÉEL sur un arbre réel. Simuler un
 *     « timed out » avec un faux `execFile` prouverait que le message se met en
 *     forme, pas que la borne se déclenche ;
 *   - un propriétaire dont le dossier est gros mais légitime doit pouvoir
 *     relever la borne plutôt que de perdre son filet.
 *
 * Une valeur d'environnement illisible ne retombe pas en silence sur le défaut
 * (invariant #4) : elle est dite, une fois, puis ignorée.
 */
let badTimeoutSaid = false;
function storeTimeoutMs(explicit?: number): number {
  if (explicit !== undefined) {
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    throw new Error(`invalid snapshot timeout: ${explicit}`);
  }
  const raw = process.env['NODALAI_CHECKPOINT_TIMEOUT_MS'];
  if (raw === undefined || raw === '') return GIT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  if (!badTimeoutSaid) {
    badTimeoutSaid = true;
    console.warn(
      `[checkpoints] NODALAI_CHECKPOINT_TIMEOUT_MS=${JSON.stringify(raw)} is not a positive ` +
        `number of milliseconds. Using ${GIT_TIMEOUT_MS} ms.`,
    );
  }
  return GIT_TIMEOUT_MS;
}

/**
 * `execFile` tue l'enfant quand la borne tombe et rejette avec `killed`. Un
 * `ETIMEDOUT` est la même chose dite autrement selon la plateforme, d'où les
 * deux. Aucun appel du chemin d'instantané ne tue l'enfant qu'il lance, donc
 * `killed` ne peut venir que de la borne.
 */
function isTimeoutError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { killed?: boolean; code?: unknown };
  return e.killed === true || e.code === 'ETIMEDOUT';
}

/**
 * Il n'y a pas de git sur le PATH, dit AVANT d'avoir lancé quoi que ce soit.
 *
 * Une erreur à part, et non un `ENOENT` de spawn maquillé : c'est la résolution
 * qui a répondu « aucun », et confondre les deux ferait croire à un lecteur du
 * code qu'un processus a été lancé.
 */
class GitBinaryMissingError extends Error {
  constructor() {
    super(
      'git is not on PATH: no checkpoint can be taken or read. ' +
        'Install git, or make it reachable from the process PATH.',
    );
    this.name = 'GitBinaryMissingError';
  }
}

/**
 * QUEL git est lancé — le chemin ABSOLU du git du système, jamais le nom nu
 * (issue #251).
 *
 * Toutes les commandes d'ici tournent avec `GIT_WORK_TREE` sur le workspace du
 * propriétaire, c'est-à-dire sur un dossier où l'agent écrit : c'est la même
 * famille de risque que le constat d'écritures (#227) et que `apps/web` (#244),
 * donc la même résolution, celle de `@nodal-agents/shared/git-binary`.
 *
 * Pas de git ⇒ ON LÈVE, fort et clair. Aucun repli sur le nom nu, et surtout
 * aucun instantané « réussi » sans filet derrière (invariant #4).
 */
async function gitBinary(): Promise<string> {
  const binaire = await resolveGitBinary();
  if (binaire === null) throw new GitBinaryMissingError();
  return binaire;
}

/**
 * `git` introuvable — soit la résolution l'a dit avant de lancer, soit un
 * `ENOENT` est venu du spawn lui-même (un binaire effacé entre la résolution et
 * l'appel). Les deux se rendent au propriétaire sous le même code.
 */
function isGitMissingError(err: unknown): boolean {
  if (err instanceof GitBinaryMissingError) return true;
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; syscall?: unknown };
  return e.code === 'ENOENT' && typeof e.syscall === 'string' && e.syscall.startsWith('spawn');
}

/**
 * git A RÉPONDU, et sa réponse est « non ».
 *
 * `err.code` est alors le CODE DE SORTIE, un nombre, et l'enfant n'a pas été
 * tué. Un `ENOENT` porte une chaîne, un dépassement de borne porte `killed` :
 * ni l'un ni l'autre n'est une réponse, et les confondre avec « non » est
 * exactement le défaut que `gitAllowingMiss` existe pour interdire.
 */
function isOrdinaryExitFailure(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { killed?: boolean; code?: unknown };
  return e.killed !== true && typeof e.code === 'number';
}

/**
 * Comme `git`, mais une réponse NÉGATIVE de git rend `''` au lieu de lever.
 *
 * Ce que ce nom protège (revue de la PR #262, passe 1). Les deux lectures de
 * l'instantané — « ce dossier a-t-il déjà une photo ? » et « son arbre est-il
 * celui d'aujourd'hui ? » — portaient un `.catch(() => '')` nu. Après l'ajout
 * de la borne de temps (#245), un `rev-parse` TUÉ par cette borne se lisait
 * donc « pas de parent » : `commit-tree` repartait sans `-p`, `update-ref`
 * posait un commit RACINE, et la chaîne des checkpoints était coupée en
 * silence — la photo d'avant devenait irretrouvable, sans une ligne nulle part.
 *
 * Un `catch` qui avale tout ne distingue pas un refus d'une panne. Celui-ci ne
 * garde que le refus : une sortie non nulle ordinaire. Un dépassement de
 * borne, un `git` absent, un magasin illisible remontent, et le refus qui en
 * découle dit lequel.
 *
 * Exporté pour son test : c'est la distinction elle-même qui doit être
 * épinglée, et un dépassement de borne ne peut pas être provoqué SUR CET
 * APPEL-LÀ depuis l'extérieur (chaque commande a sa propre borne, et `add -A`
 * est toujours plus lent que `rev-parse` : aucune valeur ne tue le second sans
 * tuer le premier).
 */
export async function gitAllowingMiss(
  store: string,
  workspace: string,
  args: string[],
  /** `where` : le magasin seul (l'hôte) par défaut ; l'arbre pour une lecture qui le touche. */
  opts: { indexFile?: string; timeoutMs?: number; where?: Where } = {},
): Promise<string> {
  try {
    return await git(
      store,
      workspace,
      args,
      opts.where ?? STORE,
      opts.indexFile,
      opts.timeoutMs ?? storeTimeoutMs(),
    );
  } catch (err) {
    if (isOrdinaryExitFailure(err)) return '';
    throw err;
  }
}

/**
 * Qualifie un échec du magasin : un CODE, et les faits qui vont avec.
 *
 * LA MESURE N'EST FAITE QUE SUR UN DÉPASSEMENT DE BORNE EN PHOTOGRAPHIANT,
 * parce que c'est le seul cas où elle répond à la question posée. Photographier
 * parcourt le dossier de l'utilisateur, donc sa taille EST la cause et le geste
 * suit. Relire ne touche que le magasin : compter le dossier y nommerait un
 * coupable au hasard, et le compter sur le chemin d'un clic qui vient d'échouer
 * ferait payer une seconde attente pour un chiffre faux (revue #262, passe 2).
 * Sur un `git` absent, il n'y a rien à mesurer non plus.
 */
async function qualifyFailure(
  err: unknown,
  operation: CheckpointOperation,
  workspace: string,
  limitMs: number | null,
  elapsedMs: number | null,
): Promise<CheckpointError> {
  const gitMessage =
    err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err);
  const cause: CheckpointFailureCause = isGitMissingError(err)
    ? 'git_missing'
    : isTimeoutError(err)
      ? 'timeout'
      : 'other';
  const code = checkpointFailureCode(cause, operation);
  const measure =
    code === 'snapshot_timeout' ? await measureWorkspace(workspace).catch(() => null) : null;
  return new CheckpointError({
    code,
    operation,
    workspace,
    limitMs,
    elapsedMs,
    measure,
    gitMessage,
  });
}

/**
 * Le `try` de toute LECTURE du magasin (revue #262, passe 2).
 *
 * `listCheckpoints` et `diffFile` avalaient chaque panne dans une réponse vide :
 * « aucun checkpoint » sur un magasin qui en a, « pas dans l'instantané » sur un
 * chemin photographié. Le même silence que ce lot supprime ailleurs, sur les
 * magasins qui grossissent — donc le même traitement, à un endroit.
 *
 * Une erreur déjà qualifiée passe telle quelle : une lecture imbriquée dans une
 * autre ne doit pas être requalifiée en boucle.
 */
async function readingStore<T>(workspace: string, lire: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    return await lire();
  } catch (err) {
    if (isCheckpointError(err)) throw err;
    throw await qualifyFailure(err, 'read', workspace, storeTimeoutMs(), Date.now() - startedAt);
  }
}

/**
 * Never snapshotted. Dependency trees and build output are large, regenerable,
 * and are exactly what makes a naive `add -A` take minutes on a real project.
 *
 * La liste vient de `failure.ts`, que la MESURE d'un refus utilise aussi : deux
 * listes auraient dérivé, et un refus aurait alors annoncé une taille que git
 * n'avait jamais eu à enregistrer (#245, revue passe 1).
 */
const EXCLUDES = [
  ...SKIPPED_DIRS.map((dir) => `${dir}/`),
  ...SKIPPED_FILE_SUFFIXES.map((suffixe) => `*${suffixe}`),
];

/**
 * What a checkpoint does NOT cover — one sentence, so the limit travels with
 * the feature instead of living only in a code comment nobody reads before
 * losing a file. Rendered wherever checkpoints are presented to a human.
 */
export const CHECKPOINT_COVERAGE_NOTE =
  'Checkpoints cover files tracked by an ordinary `git add`: anything the ' +
  "project's own .gitignore excludes (.env, local data, caches) is NOT " +
  'snapshotted and cannot be restored. That is deliberate — copying ignored ' +
  'secrets into a second, unmanaged store would be worse than the gap.';

export interface Checkpoint {
  /** Commit sha in the shadow store. */
  sha: string;
  /** The workspace this snapshot belongs to. */
  workspace: string;
  /** ISO timestamp. */
  at: string;
  /** What was about to happen — the tool name and the job it belonged to. */
  label: string;
}

/**
 * One short, stable id per workspace path — the shadow store's ref name.
 *
 * The normalisation is the whole function, and it was wrong until a live test
 * caught it: lowercasing alone left `C:/Users/x` and `C:\Users\x` hashing
 * differently, so a snapshot taken through one spelling was invisible to a
 * `checkpoints list` that resolved the other. The store filled up and the
 * command reported nothing — no error, no clue.
 *
 * Windows treats both separators and both cases as the same path, so the key
 * must too. A trailing separator is dropped for the same reason.
 */
function workspaceKey(workspace: string): string {
  let norm = workspace;
  if (process.platform === 'win32') {
    norm = norm.toLowerCase().replace(/\//g, '\\');
  }
  norm = norm.replace(/[\\/]+$/, '');
  return createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

/** L'environnement d'un git qui ne lit QUE le magasin : pas d'arbre de travail. */
function storeEnv(store: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_DIR: join(store, 'store'),
    // A checkpoint is machinery, not authorship. Identity is fixed so it can
    // never depend on — or leak — the owner's git config.
    GIT_AUTHOR_NAME: 'Nodal checkpoints',
    GIT_AUTHOR_EMAIL: 'checkpoints@nodal.local',
    GIT_COMMITTER_NAME: 'Nodal checkpoints',
    GIT_COMMITTER_EMAIL: 'checkpoints@nodal.local',
    // The owner's global config must not change what we store or how.
    GIT_CONFIG_GLOBAL: join(store, 'gitconfig'),
    GIT_CONFIG_SYSTEM: join(store, 'gitconfig'),
    // Aucune maintenance automatique : elle réécrirait le magasin depuis un git
    // qui n'a pas à l'écrire (et échouerait, en lecture seule, dans le conteneur).
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'gc.auto',
    GIT_CONFIG_VALUE_0: '0',
    GIT_CONFIG_KEY_1: 'maintenance.auto',
    GIT_CONFIG_VALUE_1: 'false',
  };
  delete env['GIT_WORK_TREE'];
  delete env['GIT_INDEX_FILE'];
  delete env['GIT_OBJECT_DIRECTORY'];
  delete env['GIT_ALTERNATE_OBJECT_DIRECTORIES'];
  return env;
}

/**
 * L'environnement d'un git selon `where`. Sur l'arbre de travail : l'arbre,
 * l'index (la copie du jetable, sauf un `indexFile` donné), et les objets
 * neufs dans le jetable, ceux du magasin lus en alternate.
 */
function gitEnv(
  store: string,
  workspace: string,
  where: Where,
  indexFile?: string,
): NodeJS.ProcessEnv {
  if (where.kind === 'store') return storeEnv(store);
  return {
    ...storeEnv(store),
    GIT_WORK_TREE: workspace,
    GIT_INDEX_FILE: indexFile ?? where.scratch.index,
    GIT_OBJECT_DIRECTORY: where.scratch.objects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(store, 'store', 'objects'),
  };
}

/**
 * Lance git selon `where` : le magasin seul, TOUJOURS sur l'hôte (il ne lit
 * que la config de Nodal, et lui seul écrit le magasin) ; l'arbre de travail,
 * avec les programmes de l'opération, magasin en lecture.
 */
function runGit(
  store: string,
  workspace: string,
  args: readonly string[],
  where: Where,
  opts: {
    indexFile?: string;
    timeout: number;
    maxBuffer?: number;
    extraEnv?: Readonly<Record<string, string>>;
  },
): Promise<{ stdout: string; stderr: string }> {
  return gitBinary().then((binaire) => {
    const env = { ...gitEnv(store, workspace, where, opts.indexFile), ...opts.extraEnv };
    const common = {
      timeout: opts.timeout,
      ...(opts.maxBuffer !== undefined ? { maxBuffer: opts.maxBuffer } : {}),
      env,
    };
    return where.kind === 'store'
      ? hostGit.execFile(binaire, args, { ...common, writableRoots: [], readableRoots: [] })
      : programs().execFile(binaire, args, {
          ...common,
          ...worktreeRoots(store, workspace, where.scratch),
        });
  });
}

async function git(
  store: string,
  workspace: string,
  args: string[],
  where: Where,
  indexFile?: string,
  /** La borne de CET appel. Seul l'instantané la surcharge — voir storeTimeoutMs. */
  timeoutMs: number = storeTimeoutMs(),
): Promise<string> {
  const { stdout } = await runGit(store, workspace, args, where, { indexFile, timeout: timeoutMs });
  return stdout.trim();
}

/**
 * Comme `git`, mais SANS `trim` et avec un tampon large : la sortie d'un diff
 * est significative caractère par caractère (une ligne de contexte commence par
 * une espace, qu'un `trim` mangerait sur la première ligne d'un fragment) et
 * dépasse volontiers le méga-octet par défaut d'`execFile`.
 */
async function gitRaw(
  store: string,
  workspace: string,
  args: string[],
  where: Where,
): Promise<string> {
  const { stdout } = await runGit(store, workspace, args, where, {
    timeout: storeTimeoutMs(),
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Coupe un `Buffer` à `max` octets SANS couper un caractère UTF-8 en deux : si
 * l'octet `max` est la suite d'un caractère commencé avant, on recule jusqu'à
 * son premier octet et on coupe là (revue Codex, passe 43 — une séquence
 * incomplète décodée devient U+FFFD, trois octets, et la borne « en octets »
 * mentait d'un ou deux).
 */
function cutAtUtf8Boundary(buf: Buffer, max: number): Buffer {
  if (buf.length <= max) return buf;
  let end = max;
  // 0b10xxxxxx = octet de continuation : le caractère a commencé plus tôt.
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end);
}

/**
 * Comme `gitRaw`, mais la sortie est lue EN FLUX et coupée à `maxBytes` : au
 * premier octet de trop, on DEMANDE l'arrêt du processus et ce qu'on a lu est
 * rendu, dit tronqué (revue Codex, passe 42). Sans ça, un diff de 10 Mo
 * faisait exploser le tampon d'`execFile` AVANT la coupe, et l'écran disait
 * « dossier injoignable » pour un fichier simplement gros. Les OCTETS sont
 * comptés (un `Buffer`), pas les unités UTF-16 d'une chaîne, et la coupe
 * respecte les frontières UTF-8 : la borne annoncée est la borne réelle.
 *
 * ON NE RÉSOUT QU'À `close` (revue Codex, passe 43), même après `kill()` :
 * l'appelant supprime l'index jetable juste après, et sous Windows un fichier
 * encore ouvert par git ne se supprime pas (`EBUSY`) — chaque index orphelin
 * aurait pesé le poids d'un index complet.
 */
async function gitRawCapped(
  store: string,
  workspace: string,
  args: string[],
  maxBytes: number,
  where: Where,
): Promise<{ text: string; truncated: boolean }> {
  // Résolu AVANT d'ouvrir la promesse : `spawn` ne sait pas attendre, et un
  // `git` nu laisserait le système chercher le programme (#251).
  const binaire = await gitBinary();
  // Rejette si git ne peut pas démarrer (l'erreur du système, ou celle du bac
  // à sable) — l'équivalent de l'événement `error` d'avant. Le magasin seul :
  // sur l'hôte ; l'arbre : avec les programmes de l'opération.
  const env = gitEnv(store, workspace, where);
  const child =
    where.kind === 'store'
      ? await hostGit.spawn(binaire, args, { env, writableRoots: [], readableRoots: [] })
      : await programs().spawn(binaire, args, {
          env,
          ...worktreeRoots(store, workspace, where.scratch),
        });
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  let timedOut = false;
  const limitMs = storeTimeoutMs();
  const timer = setTimeout(() => {
    timedOut = true;
    // L'arrêt est demandé ; la promesse se règle à `close`, pas avant.
    child.kill();
  }, limitMs);
  child.stdout.on('data', (chunk: Buffer) => {
    if (truncated) return;
    chunks.push(chunk);
    size += chunk.length;
    if (size > maxBytes) {
      truncated = true;
      // Tout ce qu'il fallait est là : inutile de laisser git écrire la suite.
      child.kill();
    }
  });
  // Rien n'est lu de stderr, mais il est vidé : un tuyau plein bloquerait git.
  child.stderr.resume();
  const { code } = await child.closed;
  clearTimeout(timer);
  if (timedOut) throw new Error(`git ${args[0]} timed out after ${limitMs} ms`);
  if (!truncated && code !== 0 && code !== null) {
    throw new Error(`git ${args[0]} exited with ${code}`);
  }
  const all = Buffer.concat(chunks);
  const cut = truncated ? cutAtUtf8Boundary(all, maxBytes) : all;
  return { text: cut.toString('utf8'), truncated };
}

/** Create the shared shadow store if it does not exist yet. Idempotent. */
export async function ensureStore(store: string): Promise<void> {
  const gitDir = join(store, 'store');
  await mkdir(join(store, 'indexes'), { recursive: true });
  await writeFile(join(store, 'gitconfig'), '', { flag: 'a' });
  if (!existsSync(join(gitDir, 'HEAD'))) {
    await mkdir(gitDir, { recursive: true });
    // LA CONSTANTE, pas la borne surchargeable : créer un dépôt nu vide ne
    // dépend d'aucun arbre, donc rien ne justifie qu'une borne serrée posée
    // pour un gros dossier empêche le magasin d'exister (#262, passe 2).
    await run(await gitBinary(), ['init', '--bare', '--quiet', gitDir], {
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    // Excludes live in the store, not in the user's workspace: a checkpoint
    // must never add a file to a project it is protecting.
    await mkdir(join(gitDir, 'info'), { recursive: true });
    await writeFile(join(gitDir, 'info', 'exclude'), EXCLUDES.join('\n') + '\n', 'utf-8');
  }
}

export interface SnapshotOptions {
  /**
   * Borne de temps de chaque commande git de cet instantané, en millisecondes.
   * Par défaut `NODALAI_CHECKPOINT_TIMEOUT_MS`, sinon 30 s.
   */
  timeoutMs?: number;
  /** Qui lance git (voir « Qui lance git ») ; l'hôte par défaut. */
  programs?: CheckpointPrograms;
}

/**
 * Snapshot `workspace` as it is right now. Returns the checkpoint, or null when
 * there was nothing to record (an unchanged tree since the last snapshot).
 *
 * Throws on a real failure, and depuis #245 il lève TOUJOURS une
 * `CheckpointError` : un code (`snapshot_timeout`, `git_missing`,
 * `snapshot_failed`) et, sur un dépassement de borne, la taille et le nombre de
 * fichiers mesurés. L'appelant refuse l'écriture plutôt que d'avancer sans
 * filet — un checkpoint qui échoue en silence est pire que pas de checkpoint,
 * parce que c'est celui que le propriétaire croyait avoir — mais il peut
 * désormais DIRE pourquoi, au lieu d'envoyer les agents en chasse.
 */
export async function snapshot(
  store: string,
  workspace: string,
  label: string,
  options: SnapshotOptions = {},
): Promise<Checkpoint | null> {
  const limitMs = storeTimeoutMs(options.timeoutMs);
  const startedAt = Date.now();
  try {
    return await withPrograms(options.programs, () =>
      takeSnapshot(store, workspace, label, limitMs),
    );
  } catch (err) {
    throw await qualifyFailure(err, 'snapshot', workspace, limitMs, Date.now() - startedAt);
  }
}

async function takeSnapshot(
  store: string,
  workspace: string,
  label: string,
  limitMs: number,
): Promise<Checkpoint | null> {
  await ensureStore(store);
  const key = workspaceKey(workspace);
  const ref = `refs/nodal/${key}`;

  // `add -A` WITHOUT `-f` — a deliberate hole, documented rather than hidden.
  //
  // git honours the workspace's own `.gitignore` here, so a file the project
  // ignores (`.env`, `data/private.json`, local caches) is NOT in the snapshot
  // and CANNOT be restored. `-Af` would close that hole, and open a worse one:
  // every secret the project deliberately keeps out of version control would
  // be copied, in cleartext, into a shadow store under the user's home — kept
  // for as long as the checkpoints are, and never covered by the project's own
  // secret hygiene.
  //
  // Between "a wrong write to an ignored file cannot be undone" and "every
  // secret gets a second, unmanaged copy", the first is the smaller harm. But
  // it is only acceptable while it is SAID: see CHECKPOINT_COVERAGE_NOTE and
  // the test that pins this behaviour, so nobody discovers it from a lost file.
  //
  // L'ARBRE DE TRAVAIL est lu par un git qui n'écrit que le jetable (voir « Qui
  // lance git ») ; le magasin n'est écrit que plus bas, sur l'hôte.
  const scratch = await openScratch(store, workspace, true);
  try {
    const wt = onWorktree(scratch);
    await git(store, workspace, ['add', '-A'], wt, undefined, limitMs);
    const tree = await git(store, workspace, ['write-tree'], wt, undefined, limitMs);
    // L'arbre que ce git annonce n'est cru qu'importé, vérifié, et d'un arbre.
    await importObjects(store, scratch);
    const kind = await git(store, workspace, ['cat-file', '-t', tree], STORE, undefined, limitMs);
    if (kind !== 'tree') throw new Error(`CHECKPOINT_NOT_A_TREE: ${tree} is a ${kind}`);
    await keepScratchIndex(store, workspace, scratch);

    // Nothing changed since the last checkpoint — recording it again would bury
    // the useful ones under identical noise.
    // `gitAllowingMiss`, jamais un `.catch(() => '')` nu : une ref absente est
    // une RÉPONSE de git, un dépassement de borne est une PANNE, et lire la
    // seconde comme la première pose un commit racine (revue #262, passe 1).
    const parent = await gitAllowingMiss(
      store,
      workspace,
      ['rev-parse', '--verify', '--quiet', ref],
      { timeoutMs: limitMs },
    );
    if (parent) {
      const parentTree = await gitAllowingMiss(
        store,
        workspace,
        ['rev-parse', `${parent}^{tree}`],
        { timeoutMs: limitMs },
      );
      if (parentTree === tree) return null;
    }

    const at = new Date().toISOString();
    const args = ['commit-tree', tree, '-m', `${label} — ${at}`];
    if (parent) args.push('-p', parent);
    const sha = await git(store, workspace, args, STORE, undefined, limitMs);
    await git(store, workspace, ['update-ref', ref, sha], STORE, undefined, limitMs);

    return { sha, workspace, at, label };
  } finally {
    await closeScratch(scratch);
  }
}

/**
 * Ce qu'un instantané ne photographie jamais, en plus du `.gitignore` du
 * workspace : les exclusions du magasin. Exporté pour que le constat des
 * écritures qui lit un instantané (#590) puisse DIRE ce qu'il ne voit pas.
 */
export const SNAPSHOT_EXCLUDES: readonly string[] = EXCLUDES;

/**
 * Une copie FIGÉE de l'index de l'instantané d'un workspace (#590).
 *
 * Le constat des écritures (`packages/tools`, git-constat.ts) ne voyait que les
 * dossiers qui sont eux-mêmes la racine d'un dépôt git. Un workspace hors de
 * tout dépôt, ou dans un dépôt enraciné AU-DESSUS de lui (une maison
 * versionnée), ne constatait rien de ce qu'un shell y écrivait. L'instantané,
 * pris avant tout outil qui écrit, est justement un état d'avant de ce
 * workspace : son index EST cet état, avec les stats de chaque fichier.
 *
 * POURQUOI UNE COPIE, et pas l'index lui-même (revue A de #591) : l'index est
 * PARTAGÉ par tous les jobs de ce workspace, et chaque instantané le restage
 * (`add -A`). Un instantané d'un autre job pris entre l'avant et l'après d'un
 * appel y faisait entrer les fichiers que cet appel venait d'écrire : ils
 * sortaient des deux lectures, et l'écriture était perdue. La copie ne bouge
 * plus ; les deux lectures d'un appel se font contre elle.
 *
 * POURQUOI L'INDEX, et pas l'arbre du commit : un index porte les stats de
 * chaque fichier, donc git ne relit que ceux qui ont bougé. Un index refait
 * depuis l'arbre (`read-tree`) n'en a pas, et chaque lecture rehacherait tout
 * le dossier — un dossier d'images de plusieurs gigaoctets, deux fois par
 * appel. La copie garde la date de l'original (`copyIndex`), pour que git juge
 * les fichiers « modifiés dans le même tic » exactement comme sur l'original.
 *
 * Rangée à côté de l'index, comme l'index jetable de `diffFile`, et retirée par
 * `releaseFrozenIndex`. Chaque absence a sa raison : pas de magasin, jamais
 * photographié, copie impossible.
 *
 * LA COPIE EST UNE SEULE LECTURE (revue A de #591, passe 2) : voir
 * `copyIndex`. Une lecture qui échoue quand même est retentée deux fois, 50 ms
 * plus tard, et au bout de ces trois essais c'est `freeze_failed`.
 */
export type FrozenSnapshotIndex =
  | { readonly kind: 'frozen'; readonly indexFile: string }
  | {
      readonly kind: 'none';
      readonly reason: 'no_store' | 'never_snapshotted' | 'freeze_failed';
    };

const FREEZE_ATTEMPTS = 3;
const FREEZE_RETRY_MS = 50;

export async function freezeSnapshotIndex(
  store: string,
  workspace: string,
): Promise<FrozenSnapshotIndex> {
  if (!existsSync(join(store, 'store', 'HEAD'))) return { kind: 'none', reason: 'no_store' };
  const source = join(store, 'indexes', workspaceKey(workspace));
  if (!existsSync(source)) return { kind: 'none', reason: 'never_snapshotted' };
  const indexFile = `${source}.constat-${randomBytes(6).toString('hex')}`;
  for (let essai = 1; essai <= FREEZE_ATTEMPTS; essai++) {
    try {
      await copyIndex(source, indexFile);
      return { kind: 'frozen', indexFile };
    } catch {
      await rm(indexFile, { force: true }).catch(() => undefined);
      if (essai < FREEZE_ATTEMPTS) await new Promise((r) => setTimeout(r, FREEZE_RETRY_MS));
    }
  }
  return { kind: 'none', reason: 'freeze_failed' };
}

/**
 * Le statut contre une copie figée, ou la cause pour laquelle il n'y en a pas.
 * Chaque cause a son nom, comme dans `gitAllowingMiss` (revue #262) : un git
 * absent, une borne de temps dépassée, une sortie trop longue et un refus de
 * git (index illisible) ne se réparent pas du même geste.
 */
export type FrozenIndexStatus =
  | { readonly kind: 'status'; readonly stdout: string }
  | {
      readonly kind: 'failed';
      readonly reason:
        | 'git_missing'
        | 'snapshot_status_timeout'
        | 'snapshot_status_too_large'
        | 'snapshot_status_failed';
    };

/** La sortie de `git status` au-delà de laquelle la lecture est abandonnée. */
const FROZEN_STATUS_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * `git status --porcelain -z --untracked-files=all` du workspace contre une
 * copie figée (`freezeSnapshotIndex`). Mêmes exclusions que l'instantané.
 *
 * Seule la colonne de DROITE (index ↔ arbre de travail) et les `??` disent
 * quelque chose : le magasin n'a jamais de HEAD, donc la colonne de gauche
 * marque `A` chaque fichier photographié. C'est à l'appelant de la lire ainsi.
 *
 * `GIT_OPTIONAL_LOCKS=0` : une lecture ne réécrit pas la copie.
 */
export async function statusAgainstFrozenIndex(
  store: string,
  workspace: string,
  indexFile: string,
  /** Qui lance git (voir « Qui lance git ») ; l'hôte par défaut. */
  given?: CheckpointPrograms,
): Promise<FrozenIndexStatus> {
  // Une LECTURE de l'arbre : son git n'écrit que le jetable, magasin en lecture
  // (voir « Qui lance git »). L'index lu est la copie figée.
  let scratch: Scratch | undefined;
  try {
    scratch = await openScratch(store, workspace, false);
    const wt = onWorktree(scratch);
    const { stdout } = await withPrograms(given, () =>
      runGit(store, workspace, ['status', '--porcelain', '-z', '--untracked-files=all'], wt, {
        indexFile,
        timeout: storeTimeoutMs(),
        maxBuffer: FROZEN_STATUS_MAX_BUFFER,
        extraEnv: { GIT_OPTIONAL_LOCKS: '0' },
      }),
    );
    return { kind: 'status', stdout };
  } catch (err) {
    // La sortie trop longue AVANT la borne de temps : Node tue aussi l'enfant
    // dans ce cas (`killed`), et le lire comme un délai dirait le mauvais geste.
    const code = (err as { code?: unknown } | null)?.code;
    const reason = isGitMissingError(err)
      ? 'git_missing'
      : code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        ? 'snapshot_status_too_large'
        : isTimeoutError(err)
          ? 'snapshot_status_timeout'
          : 'snapshot_status_failed';
    return { kind: 'failed', reason };
  } finally {
    if (scratch) await closeScratch(scratch);
  }
}

/** Retire une copie figée. Sans effet si elle n'est déjà plus là. */
export async function releaseFrozenIndex(indexFile: string): Promise<void> {
  await rm(indexFile, { force: true }).catch(() => undefined);
}

/**
 * Le sha du DERNIER instantané de ce dossier, ou null s'il n'y en a jamais eu.
 *
 * Existe pour le cas que `snapshot` rend `null` : l'arbre n'a pas bougé depuis
 * la dernière photo, donc rien n'est réenregistré — mais l'état d'avant du tour
 * courant EST ce commit-là, et sans lui la ligne `job_checkpoints` de ce tour
 * n'aurait aucun sha à porter. Une lecture, jamais une écriture.
 */
export async function headCheckpoint(store: string, workspace: string): Promise<string | null> {
  // Le magasin SEUL : sur l'hôte, sans arbre de travail (voir « Qui lance git »).
  if (!existsSync(join(store, 'store', 'HEAD'))) return null;
  const ref = `refs/nodal/${workspaceKey(workspace)}`;
  // `--verify --quiet` : ref absente ⇒ sortie vide et code 1, donc rejet, d'où
  // `gitAllowingMiss`. Comme dans `snapshot`, une PANNE remonte au lieu d'être
  // lue comme une absence (revue #262, passe 1).
  //
  // Ce que ça change pour l'appelant, et c'est VOULU : `takeCliTurnCheckpoints`
  // entoure cet appel du `try` qui refuse le tour. Une lecture qui panne y
  // refusera donc, comme un instantané qui panne — mieux que d'inscrire, ou de
  // ne pas inscrire, une ligne d'audit sur une réponse qu'on n'a pas eue.
  const sha = await gitAllowingMiss(store, workspace, ['rev-parse', '--verify', '--quiet', ref]);
  return sha === '' ? null : sha;
}

// ─── Le diff d'un fichier entre deux instantanés ─────────────────────────────

/**
 * Au-delà, le texte est coupé et le dit. Un diff de 200 Ko est déjà plus long
 * que ce que quiconque lira ; ce qui compte est que la coupe soit ANNONCÉE.
 * Des OCTETS (la sortie de git est lue en `Buffer`), pas des caractères.
 */
export const DIFF_MAX_BYTES = 200_000;

export type FileDiff =
  | { kind: 'diff'; text: string; truncated: boolean }
  /** Git ne sait pas diffuser ce contenu (image, archive, exécutable). */
  | { kind: 'binary' }
  /** Le fichier est identique entre les deux états. */
  | { kind: 'unchanged' }
  /**
   * Le chemin n'est dans AUCUN des deux états — le cas normal étant un fichier
   * que le `.gitignore` du dossier exclut : voir CHECKPOINT_COVERAGE_NOTE, un
   * instantané fait `add -A` SANS `-f` et ne photographie donc pas ces
   * fichiers-là. Ils existent sur le disque, mais pas dans l'histoire.
   */
  | { kind: 'not_in_snapshot' };

/**
 * Ce qui a changé dans UN fichier entre deux instantanés du même dossier.
 *
 * `toSha` null = l'arbre de travail d'aujourd'hui, c'est-à-dire le dernier tour
 * d'un travail encore en cours.
 *
 * POURQUOI UN INDEX TEMPORAIRE pour le cas « arbre de travail ». `git diff
 * <commit>` ne montre que les fichiers SUIVIS, et le suivi vit dans l'index.
 * Un fichier créé APRÈS le dernier instantané n'y est pas : le diff serait
 * vide, et l'écran dirait « aucun changement » sur un fichier que l'agent
 * vient d'écrire. Il faut donc restager le chemin demandé — mais JAMAIS dans
 * l'index du dossier, celui que `snapshot` utilise (revue Codex, passe 42) :
 * une lecture qui y écrivait pouvait tenir `index.lock` au moment où le tour
 * suivant prenait sa photo, et faire refuser ce tour (`checkpoint_failed`)
 * pour un panneau ouvert dans le fil. Chaque lecture a donc SON index, jetable
 * : rempli depuis le commit d'avant (`read-tree`), le seul chemin demandé y
 * est restagé, le diff se lit `--cached`, et le fichier est supprimé. Le dépôt
 * du propriétaire n'est jamais touché (le magasin est un git fantôme).
 *
 * `relPath` est relatif au dossier, en forme slash.
 *
 * LÈVE une `CheckpointError` si le magasin ne répond pas (revue #262, passe 2).
 * Rendre `not_in_snapshot` sur un dépassement de borne disait « ce fichier n'a
 * jamais été photographié » d'un fichier qui l'est. Un chemin réellement absent
 * des deux états rend toujours `not_in_snapshot`, lui.
 */
export function diffFile(
  store: string,
  workspace: string,
  fromSha: string,
  toSha: string | null,
  relPath: string,
  /** Qui lance git (voir « Qui lance git ») ; l'hôte par défaut. */
  given?: CheckpointPrograms,
): Promise<FileDiff> {
  return readingStore(workspace, () =>
    withPrograms(given, () => readFileDiff(store, workspace, fromSha, toSha, relPath)),
  );
}

async function readFileDiff(
  store: string,
  workspace: string,
  fromSha: string,
  toSha: string | null,
  relPath: string,
): Promise<FileDiff> {
  if (!existsSync(join(store, 'store', 'HEAD'))) return { kind: 'not_in_snapshot' };

  // `gitAllowingMiss` partout dans cette lecture, jamais un `.catch(() => '')`
  // nu (revue #262, passe 2) : un chemin absent de l'arbre est une RÉPONSE de
  // git, un dépassement de borne est une PANNE, et rendre `not_in_snapshot`
  // pour la seconde ment sur un fichier qui EST photographié.
  const inTree = async (sha: string): Promise<boolean> =>
    (await gitAllowingMiss(store, workspace, [
      'ls-tree',
      '-r',
      '--name-only',
      sha,
      '--',
      relPath,
    ])) !== '';

  const inFrom = await inTree(fromSha);

  // Le JETABLE de cette lecture — index vide, objets neufs : jamais l'index du
  // dossier, jamais le magasin. Seul le diff contre l'ARBRE en a besoin (voir
  // « Qui lance git ») ; deux instantanés se comparent dans le magasin seul.
  const scratch = toSha === null ? await openScratch(store, workspace, false) : undefined;
  const where: Where = scratch !== undefined ? onWorktree(scratch) : STORE;
  try {
    let inTo: boolean;
    if (scratch !== undefined) {
      // L'index jetable part VIDE, et le SEUL chemin demandé y est stagé depuis
      // l'arbre de travail : un fichier neuf ou modifié y entre, un fichier
      // supprimé n'y entre pas. Le diff qui suit est restreint au même chemin
      // (`-- relPath`), donc les autres fichiers du commit d'avant, absents de
      // cet index, ne passent pas pour supprimés — pas besoin d'un `read-tree`
      // de tout l'arbre à chaque clic (revue Codex, passe 43). Un chemin ignoré
      // par le `.gitignore` du dossier fait échouer `add` — c'est exactement
      // l'information qu'on cherche, pas une panne.
      await gitAllowingMiss(store, workspace, ['add', '-A', '--', relPath], { where });
      inTo =
        (await gitAllowingMiss(store, workspace, ['ls-files', '--cached', '--', relPath], {
          where,
        })) !== '';
    } else {
      inTo = await inTree(toSha as string);
    }
    if (!inFrom && !inTo) return { kind: 'not_in_snapshot' };

    const range = scratch !== undefined ? ['--cached', fromSha] : [fromSha, toSha as string];

    // `--numstat` d'abord : il répond aux deux questions bon marché (rien n'a
    // changé / c'est du binaire) sans jamais matérialiser le texte du diff.
    // Un fichier binaire s'y écrit `-\t-\t<chemin>`.
    const numstat = await gitRaw(
      store,
      workspace,
      ['diff', '--no-color', '--numstat', ...range, '--', relPath],
      where,
    );
    if (numstat.trim() === '') return { kind: 'unchanged' };
    if (/^-\t-\t/m.test(numstat)) return { kind: 'binary' };

    const { text, truncated } = await gitRawCapped(
      store,
      workspace,
      ['diff', '--no-color', '--unified=3', ...range, '--', relPath],
      DIFF_MAX_BYTES,
      where,
    );
    return { kind: 'diff', text, truncated };
  } finally {
    if (scratch !== undefined) await closeScratch(scratch);
  }
}

/**
 * Checkpoints for a workspace, newest first.
 *
 * LÈVE une `CheckpointError` si le magasin ne répond pas (revue #262, passe 2).
 * Rendre `[]` sur un dépassement de borne affichait « aucun checkpoint » à une
 * personne dont le magasin en contient des centaines — la forme que `root.ts`
 * appelle la pire qu'un filet puisse prendre : ça n'a pas l'air cassé, ça a
 * l'air de ne jamais être arrivé. Un dossier réellement jamais photographié
 * rend toujours `[]`, lui, parce que c'est ce que git a répondu.
 */
export function listCheckpoints(
  store: string,
  workspace: string,
  limit = 20,
): Promise<Checkpoint[]> {
  // Le magasin SEUL : sur l'hôte, sans arbre de travail (voir « Qui lance git »).
  return readingStore(workspace, () => readCheckpointList(store, workspace, limit));
}

async function readCheckpointList(
  store: string,
  workspace: string,
  limit: number,
): Promise<Checkpoint[]> {
  if (!existsSync(join(store, 'store', 'HEAD'))) return [];
  const ref = `refs/nodal/${workspaceKey(workspace)}`;
  // Une ref absente est une RÉPONSE (« ce dossier n'a jamais été photographié »),
  // un dépassement de borne est une PANNE. Les confondre affichait « aucun
  // checkpoint » sur un magasin qui en a — exactement la forme que root.ts
  // appelle la pire qu'un filet puisse prendre (revue #262, passe 2).
  const out = await gitAllowingMiss(store, workspace, [
    'log',
    ref,
    `--max-count=${limit}`,
    '--format=%H%x00%aI%x00%s',
  ]);
  if (!out) return [];
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, at, subject] = line.split('\0');
      return { sha: sha ?? '', workspace, at: at ?? '', label: subject ?? '' };
    });
}

/**
 * Restore `workspace` to a checkpoint.
 *
 * Takes a snapshot of the CURRENT state first, so the restore itself is
 * undoable — rolling back is a decision too, and the state it discards may be
 * the one worth keeping.
 */
export async function restoreCheckpoint(
  store: string,
  workspace: string,
  sha: string,
  /** Qui lance git (voir « Qui lance git ») ; l'hôte par défaut. */
  given?: CheckpointPrograms,
): Promise<{ restored: string; safety: Checkpoint | null }> {
  await ensureStore(store);
  return withPrograms(given, async () => {
    const safety = await snapshot(store, workspace, `before restoring ${sha.slice(0, 8)}`);
    // Le sha restauré est un commit DU MAGASIN, vérifié avant que quiconque y
    // lise un arbre.
    const kind = await git(store, workspace, ['cat-file', '-t', sha], STORE);
    if (kind !== 'commit') throw new Error(`CHECKPOINT_NOT_A_COMMIT: ${sha} is a ${kind}`);
    // L'ARBRE est écrit par un git qui ne peut écrire que lui et le jetable ;
    // l'index du jetable devient celui du workspace (voir « Qui lance git »).
    const scratch = await openScratch(store, workspace, true);
    try {
      // -f: the working tree is expected to differ, that is the point.
      await git(store, workspace, ['checkout', '-f', sha, '--', '.'], onWorktree(scratch));
      await keepScratchIndex(store, workspace, scratch);
    } finally {
      await closeScratch(scratch);
    }
    return { restored: sha, safety };
  });
}
