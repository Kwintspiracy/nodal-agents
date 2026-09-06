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

const run = promisify(execFile);

/** A snapshot that hangs must not hold a tool call. */
const GIT_TIMEOUT_MS = 30_000;

/**
 * Never snapshotted. Dependency trees and build output are large, regenerable,
 * and are exactly what makes a naive `add -A` take minutes on a real project.
 */
const EXCLUDES = [
  'node_modules/',
  '.git/',
  '.next/',
  'dist/',
  'build/',
  '__pycache__/',
  '.venv/',
  'target/',
  '*.log',
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
): Promise<string> {
  const { stdout } = await run('git', args, {
    timeout: GIT_TIMEOUT_MS,
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
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    env: gitEnv(store, workspace, indexFile),
  });
  return stdout;
}

/**
 * Comme `gitRaw`, mais la sortie est lue EN FLUX et coupée à `maxBytes` : au
 * premier octet de trop, le processus est tué et ce qu'on a lu est rendu, dit
 * tronqué (revue Codex, passe 42). Sans ça, un diff de 10 Mo faisait exploser
 * le tampon d'`execFile` AVANT la coupe, et l'écran disait « dossier
 * injoignable » pour un fichier simplement gros. Les OCTETS sont comptés (un
 * `Buffer`), pas les unités UTF-16 d'une chaîne : la borne annoncée est la
 * borne réelle.
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
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`git ${args[0]} timed out after ${GIT_TIMEOUT_MS} ms`));
    }, GIT_TIMEOUT_MS);
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const all = Buffer.concat(chunks);
      const cut = truncated ? all.subarray(0, maxBytes) : all;
      resolve({ text: cut.toString('utf8'), truncated });
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return;
      chunks.push(chunk);
      size += chunk.length;
      if (size > maxBytes) {
        truncated = true;
        // Tout ce qu'il fallait est là : inutile de laisser git écrire la suite.
        child.kill();
        finish();
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
      if (code !== 0 && code !== null) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`git ${args[0]} exited with ${code}`));
        return;
      }
      finish();
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

/**
 * Snapshot `workspace` as it is right now. Returns the checkpoint, or null when
 * there was nothing to record (an unchanged tree since the last snapshot).
 *
 * Throws on a real failure. The caller is expected to refuse the write rather
 * than proceed without a net — a checkpoint that fails quietly is worse than no
 * checkpoint at all, because it is the one the owner thought they had.
 */
export async function snapshot(
  store: string,
  workspace: string,
  label: string,
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
  await git(store, workspace, ['add', '-A']);
  const tree = await git(store, workspace, ['write-tree']);

  // Nothing changed since the last checkpoint — recording it again would bury
  // the useful ones under identical noise.
  const parent = await git(store, workspace, ['rev-parse', '--verify', '--quiet', ref]).catch(
    () => '',
  );
  if (parent) {
    const parentTree = await git(store, workspace, ['rev-parse', `${parent}^{tree}`]).catch(
      () => '',
    );
    if (parentTree === tree) return null;
  }

  const at = new Date().toISOString();
  const args = ['commit-tree', tree, '-m', `${label} — ${at}`];
  if (parent) args.push('-p', parent);
  const sha = await git(store, workspace, args);
  await git(store, workspace, ['update-ref', ref, sha]);

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
  // `--verify --quiet` : ref absente ⇒ sortie vide et code 1, donc rejet — d'où
  // le `catch`. C'est la même forme que dans `snapshot`.
  const sha = await git(store, workspace, ['rev-parse', '--verify', '--quiet', ref]).catch(
    () => '',
  );
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
 */
export async function diffFile(
  store: string,
  workspace: string,
  fromSha: string,
  toSha: string | null,
  relPath: string,
): Promise<FileDiff> {
  if (!existsSync(join(store, 'store', 'HEAD'))) return { kind: 'not_in_snapshot' };

  const inTree = async (sha: string): Promise<boolean> =>
    (await git(store, workspace, ['ls-tree', '-r', '--name-only', sha, '--', relPath]).catch(
      () => '',
    )) !== '';

  const inFrom = await inTree(fromSha);

  // L'index JETABLE de cette lecture — jamais celui du dossier.
  const scratch =
    toSha === null
      ? join(store, 'indexes', `${workspaceKey(workspace)}.diff-${randomBytes(6).toString('hex')}`)
      : undefined;
  try {
    let inTo: boolean;
    if (scratch !== undefined) {
      // L'index part du commit d'avant, puis le SEUL chemin demandé est restagé
      // depuis l'arbre de travail : un fichier neuf y entre, un fichier
      // supprimé en sort. Un chemin ignoré par le `.gitignore` du dossier fait
      // échouer `add` — c'est exactement l'information qu'on cherche, pas une
      // panne.
      await git(store, workspace, ['read-tree', fromSha], scratch);
      await git(store, workspace, ['add', '-A', '--', relPath], scratch).catch(() => '');
      inTo =
        (await git(store, workspace, ['ls-files', '--cached', '--', relPath], scratch).catch(
          () => '',
        )) !== '';
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

/** Checkpoints for a workspace, newest first. */
export async function listCheckpoints(
  store: string,
  workspace: string,
  limit = 20,
): Promise<Checkpoint[]> {
  if (!existsSync(join(store, 'store', 'HEAD'))) return [];
  const ref = `refs/nodal/${workspaceKey(workspace)}`;
  const out = await git(store, workspace, [
    'log',
    ref,
    `--max-count=${limit}`,
    '--format=%H%x00%aI%x00%s',
  ]).catch(() => '');
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
