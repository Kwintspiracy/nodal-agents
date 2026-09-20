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

import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

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

/** `git` introuvable : l'`ENOENT` vient du spawn, pas d'un fichier du dossier. */
function isGitMissingError(err: unknown): boolean {
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
  opts: { indexFile?: string; timeoutMs?: number } = {},
): Promise<string> {
  try {
    return await git(store, workspace, args, opts.indexFile, opts.timeoutMs ?? storeTimeoutMs());
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

function gitEnv(store: string, workspace: string, indexFile?: string): NodeJS.ProcessEnv {
  const key = workspaceKey(workspace);
  return {
    ...process.env,
    GIT_DIR: join(store, 'store'),
    GIT_WORK_TREE: workspace,
    // A per-workspace index: two workspaces snapshotting at once must not
    // stomp on each other's staging area. A READ (diffFile) brings its own
    // temporary index instead — see diffFile — so it never touches this one.
    GIT_INDEX_FILE: indexFile ?? join(store, 'indexes', key),
    // A checkpoint is machinery, not authorship. Identity is fixed so it can
    // never depend on — or leak — the owner's git config.
    GIT_AUTHOR_NAME: 'Nodal checkpoints',
    GIT_AUTHOR_EMAIL: 'checkpoints@nodal.local',
    GIT_COMMITTER_NAME: 'Nodal checkpoints',
    GIT_COMMITTER_EMAIL: 'checkpoints@nodal.local',
    // The owner's global config must not change what we store or how.
    GIT_CONFIG_GLOBAL: join(store, 'gitconfig'),
    GIT_CONFIG_SYSTEM: join(store, 'gitconfig'),
  };
}

async function git(
  store: string,
  workspace: string,
  args: string[],
  indexFile?: string,
  /** La borne de CET appel. Seul l'instantané la surcharge — voir storeTimeoutMs. */
  timeoutMs: number = storeTimeoutMs(),
): Promise<string> {
  const { stdout } = await run('git', args, {
    timeout: timeoutMs,
    windowsHide: true,
    env: gitEnv(store, workspace, indexFile),
  });
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
  indexFile?: string,
): Promise<string> {
  const { stdout } = await run('git', args, {
    timeout: storeTimeoutMs(),
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    env: gitEnv(store, workspace, indexFile),
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
function gitRawCapped(
  store: string,
  workspace: string,
  args: string[],
  maxBytes: number,
  indexFile?: string,
): Promise<{ text: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      windowsHide: true,
      env: gitEnv(store, workspace, indexFile),
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const limitMs = storeTimeoutMs();
    const timer = setTimeout(() => {
      if (settled || timedOut) return;
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
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`git ${args[0]} timed out after ${limitMs} ms`));
        return;
      }
      if (!truncated && code !== 0 && code !== null) {
        reject(new Error(`git ${args[0]} exited with ${code}`));
        return;
      }
      const all = Buffer.concat(chunks);
      const cut = truncated ? cutAtUtf8Boundary(all, maxBytes) : all;
      resolve({ text: cut.toString('utf8'), truncated });
    });
  });
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
    await run('git', ['init', '--bare', '--quiet', gitDir], {
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
    return await takeSnapshot(store, workspace, label, limitMs);
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
  await git(store, workspace, ['add', '-A'], undefined, limitMs);
  const tree = await git(store, workspace, ['write-tree'], undefined, limitMs);

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
    const parentTree = await gitAllowingMiss(store, workspace, ['rev-parse', `${parent}^{tree}`], {
      timeoutMs: limitMs,
    });
    if (parentTree === tree) return null;
  }

  const at = new Date().toISOString();
  const args = ['commit-tree', tree, '-m', `${label} — ${at}`];
  if (parent) args.push('-p', parent);
  const sha = await git(store, workspace, args, undefined, limitMs);
  await git(store, workspace, ['update-ref', ref, sha], undefined, limitMs);

  return { sha, workspace, at, label };
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
): Promise<FileDiff> {
  return readingStore(workspace, () => readFileDiff(store, workspace, fromSha, toSha, relPath));
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

  // L'index JETABLE de cette lecture — jamais celui du dossier.
  const scratch =
    toSha === null
      ? join(store, 'indexes', `${workspaceKey(workspace)}.diff-${randomBytes(6).toString('hex')}`)
      : undefined;
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
      await gitAllowingMiss(store, workspace, ['add', '-A', '--', relPath], {
        indexFile: scratch,
      });
      inTo =
        (await gitAllowingMiss(store, workspace, ['ls-files', '--cached', '--', relPath], {
          indexFile: scratch,
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
      scratch,
    );
    if (numstat.trim() === '') return { kind: 'unchanged' };
    if (/^-\t-\t/m.test(numstat)) return { kind: 'binary' };

    const { text, truncated } = await gitRawCapped(
      store,
      workspace,
      ['diff', '--no-color', '--unified=3', ...range, '--', relPath],
      DIFF_MAX_BYTES,
      scratch,
    );
    return { kind: 'diff', text, truncated };
  } finally {
    if (scratch !== undefined) await rm(scratch, { force: true }).catch(() => undefined);
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
): Promise<{ restored: string; safety: Checkpoint | null }> {
  await ensureStore(store);
  const safety = await snapshot(store, workspace, `before restoring ${sha.slice(0, 8)}`);
  // -f: the working tree is expected to differ, that is the point.
  await git(store, workspace, ['checkout', '-f', sha, '--', '.']);
  return { restored: sha, safety };
}
