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
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  utimes,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Transform, Writable, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
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
//     seul écrit le magasin, après avoir COPIÉ et VÉRIFIÉ chaque objet du
//     jetable (`importObjects`), et relu son index contre l'arbre photographié
//     (`adoptScratchIndex`) — par l'ARRIVÉE (`incoming`), que lui seul écrit.
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

/**
 * Les dossiers de travail d'une opération, sous le magasin : le JETABLE du git
 * de l'arbre (`scratch`, une de ses racines inscriptibles) et l'ARRIVÉE de
 * l'hôte (`incoming`, que seul l'hôte écrit : le magasin entier est en lecture
 * dans le conteneur). Ce qui sort du jetable passe par l'arrivée, vérifié, avant
 * d'entrer dans le magasin.
 *
 * Le nom porte la date de création (`<ms>-<16 hex>`) : un dossier qu'une
 * opération n'a pas pu retirer (un `rm` refusé, un processus tué) est récolté
 * par la suivante une fois vieux d'un jour (revue passe 6, P2). Aucune
 * opération ne dure un jour : chacune enchaîne une poignée de commandes git,
 * chacune bornée (`storeTimeoutMs`), et la vérification de l'hôte l'est aussi.
 * Un nom d'une autre forme n'est pas à nous : il n'est jamais touché.
 */
type WorkDirKind = 'scratch' | 'incoming';

const WORK_DIR_NAME = /^(\d{13})-[0-9a-f]{16}$/;
const STALE_WORK_DIR_MS = 24 * 60 * 60 * 1000;

async function openWorkDir(store: string, kind: WorkDirKind): Promise<string> {
  await reapStaleWorkDirs(store, kind);
  const dir = join(store, kind, `${Date.now()}-${randomBytes(8).toString('hex')}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function reapStaleWorkDirs(store: string, kind: WorkDirKind): Promise<void> {
  const parent = join(store, kind);
  let names: string[];
  try {
    names = await readdir(parent);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const now = Date.now();
  for (const name of names) {
    const m = WORK_DIR_NAME.exec(name);
    if (m && now - Number(m[1]) > STALE_WORK_DIR_MS) await removeWorkDir(join(parent, name));
  }
}

/**
 * Retire un dossier de travail. Un échec ne fait pas échouer l'opération, qui a
 * fini son travail ; il est DIT (invariant #4), et le dossier sera récolté.
 */
async function removeWorkDir(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (err) {
    console.error(
      `[checkpoints] CHECKPOINT_WORK_DIR_NOT_REMOVED ${dir}: ` +
        `${err instanceof Error ? err.message : String(err)}` +
        ' (reaped by the first operation once it is a day old)',
    );
  }
}

/** Ouvre un jetable sous le magasin ; `seed` y copie l'index du workspace. */
async function openScratch(store: string, workspace: string, seed: boolean): Promise<Scratch> {
  const dir = await openWorkDir(store, 'scratch');
  const objects = join(dir, 'objects');
  await mkdir(objects, { recursive: true });
  const index = join(dir, 'index');
  const source = join(store, 'indexes', workspaceKey(workspace));
  if (seed && existsSync(source)) await copyIndex(source, index);
  return { dir, objects, index };
}

async function closeScratch(scratch: Scratch): Promise<void> {
  await removeWorkDir(scratch.dir);
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
 * 71fb7bca). Le jetable de `openScratch` et la copie figée de
 * `freezeSnapshotIndex` passent par elle ; l'index qui revient du jetable
 * (`adoptScratchIndex`) est daté par le même `dateLikeIndex`.
 */
async function copyIndex(source: string, dest: string): Promise<void> {
  const { content, mtimeMs } = await readIndexOnce(await open(source, 'r'));
  await writeFile(dest, content);
  await dateLikeIndex(dest, mtimeMs);
}

/**
 * Le contenu et la date d'un index, par UNE seule poignée, puis fermée (revue
 * A de #591, passe 2). Ouverte par libuv, elle partage lecture, écriture ET
 * suppression : git remplace un index par renommage, la poignée lit donc
 * l'ancien fichier en entier, jamais un index à moitié écrit, et le renommage
 * d'un autre job passe même sous Windows, où CopyFileW tenait la source ouverte
 * sans partage de suppression.
 */
async function readIndexOnce(handle: FileHandle): Promise<{ content: Buffer; mtimeMs: number }> {
  try {
    const { mtimeMs } = await handle.stat();
    return { content: await handle.readFile(), mtimeMs };
  } finally {
    await handle.close();
  }
}

/**
 * Date `path` comme l'index lu à `mtimeMs` : arrondie VERS LE BAS à la
 * milliseconde, moins une, et jamais après maintenant. `utimes` passe par des
 * secondes en virgule flottante, dont l'erreur (de l'ordre du dixième de
 * microseconde à notre époque) pourrait dater la copie un rien APRÈS
 * l'original ; un index daté du futur n'est jamais celui qu'un git a écrit. Une
 * copie datée un rien plus tôt fait juger racy un fichier de plus, donc relu ;
 * jamais un de moins, donc manqué.
 */
async function dateLikeIndex(path: string, mtimeMs: number): Promise<void> {
  const secondes = (Math.min(Math.floor(mtimeMs), Date.now()) - 1) / 1000;
  await utimes(path, secondes, secondes);
}

/**
 * La borne de temps de la vérification de l'hôte (revue passe 6, P2) : la même
 * que chaque commande git de l'opération. Décompresser et hacher un objet que
 * le jetable a reçu prend le temps de son contenu, et une bombe zlib plantée là
 * (un mégaoctet qui se décompresse en gigaoctets) tenait l'appel d'outil au-delà
 * de toute borne. Le dépassement porte `code: 'ETIMEDOUT'` : il se qualifie
 * comme celui d'une commande git (`snapshot_timeout`).
 */
class HostDeadline {
  private readonly at: number;
  constructor(private readonly limitMs: number) {
    this.at = Date.now() + limitMs;
  }
  /** Le temps qui reste, ou le dépassement. */
  remaining(): number {
    const left = this.at - Date.now();
    if (left <= 0) throw this.exceeded();
    return left;
  }
  signal(): AbortSignal {
    return AbortSignal.timeout(this.remaining());
  }
  /** Ce qui a échoué une fois la borne passée EST le dépassement ; le reste passe tel quel. */
  explain(err: unknown): unknown {
    return Date.now() >= this.at || isTimeoutError(err) ? this.exceeded() : err;
  }
  private exceeded(): Error {
    return Object.assign(
      new Error(
        `CHECKPOINT_HOST_CHECK_TIMEOUT: checking the scratch took more than ${this.limitMs} ms`,
      ),
      { code: 'ETIMEDOUT' },
    );
  }
}

/**
 * Ouvre un fichier du JETABLE pour l'hôte : un fichier ordinaire, jamais un
 * lien suivi, jamais un fichier spécial (un tube bloquerait l'ouverture).
 * `lstat` dit ce qu'est le nom ; `O_NOFOLLOW` refuse un lien posé ensuite.
 * Sous Windows, ni l'un ni l'autre drapeau n'existe : créer un lien symbolique
 * y demande un privilège qu'une commande confinée n'a pas (mesuré : EPERM), et
 * un lien en dur est un fichier ordinaire — il est COPIÉ, jamais adopté.
 */
async function openScratchFile(path: string, what: string): Promise<FileHandle> {
  const st = await lstat(path);
  if (!st.isFile()) throw new Error(`${what}: ${path} is not a regular file`);
  const flags =
    process.platform === 'win32'
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(path, flags);
  if (!(await handle.stat()).isFile()) {
    await handle.close();
    throw new Error(`${what}: ${path} is not a regular file`);
  }
  return handle;
}

/**
 * Copie un fichier du jetable vers l'arrivée ; avec `check`, chaque morceau lu
 * y passe décompressé : les octets vérifiés SONT les octets écrits. Adopter le
 * fichier du jetable (le renommer) liait l'objet du magasin à ce fichier-là : un
 * lien en dur depuis le workspace, ou une poignée qu'un processus planté garde
 * ouverte, le réécrivait après la vérification (revue passe 6, P1).
 */
async function copyFromScratch(
  src: string,
  dst: string,
  what: string,
  deadline: HostDeadline,
  check?: Writable,
): Promise<void> {
  const lu = await openScratchFile(src, what);
  try {
    const out = await open(dst, 'wx');
    try {
      const write = new Transform({
        transform(chunk: Buffer, _enc, done) {
          out.write(chunk).then(
            () => done(null, chunk),
            (err: unknown) => done(err as Error),
          );
        },
      });
      const stream = lu.createReadStream({ autoClose: false });
      const signal = deadline.signal();
      const sink = check ?? new Writable({ write: (_c, _e, done) => done() });
      await (check
        ? pipeline(stream, write, createInflate(), sink, { signal })
        : pipeline(stream, write, sink, { signal }));
    } finally {
      await out.close();
    }
  } catch (err) {
    const explained = deadline.explain(err);
    // Un flux zlib invalide est un objet étranger, dit comme tel.
    const zlib = String((err as { code?: unknown } | null)?.code ?? '').startsWith('Z_');
    throw explained === err && zlib
      ? new Error(`${what}: ${src} is not a zlib stream (${(err as Error).message})`)
      : explained;
  } finally {
    await lu.close();
  }
}

/**
 * Ce qu'un objet libre décompressé doit être : un en-tête `type taille\0`, un
 * contenu de cette taille exacte, le tout de SHA-1 `name`. La taille est
 * vérifiée en flux : décompresser s'arrête au premier octet de trop.
 */
function looseObjectCheck(name: string): Writable {
  const hash = createHash('sha1');
  const head: Buffer[] = [];
  let headSize = 0;
  let declared = -1;
  let payload = 0;
  const foreign = (why: string): Error => new Error(`CHECKPOINT_FOREIGN_OBJECT: ${name} ${why}`);
  return new Writable({
    write(chunk: Buffer, _enc, done) {
      hash.update(chunk);
      let rest = chunk;
      if (declared < 0) {
        const nul = chunk.indexOf(0);
        headSize += nul < 0 ? chunk.length : nul;
        if (headSize > 32) return done(foreign('has no object header'));
        if (nul < 0) {
          head.push(chunk);
          return done();
        }
        head.push(chunk.subarray(0, nul));
        const m = /^(blob|tree|commit|tag) (0|[1-9][0-9]*)$/.exec(
          Buffer.concat(head).toString('latin1'),
        );
        if (!m) return done(foreign('has no object header'));
        declared = Number(m[2]);
        rest = chunk.subarray(nul + 1);
      }
      payload += rest.length;
      if (payload > declared) {
        return done(foreign(`holds more than the ${declared} bytes its header says`));
      }
      done();
    },
    final(done) {
      if (declared < 0) return done(foreign('has no object header'));
      if (payload !== declared) {
        return done(foreign(`holds ${payload} bytes, its header says ${declared}`));
      }
      const got = hash.digest('hex');
      done(got === name ? null : foreign(`holds ${got}`));
    },
  });
}

/**
 * Pose `staged` (dans l'arrivée) à `dst` dans le magasin SANS JAMAIS remplacer
 * un fichier existant : un lien en dur, qui échoue (`EEXIST`) si `dst` existe —
 * la pose de git lui-même (`finalize_object_file`). Un renommage remplace sous
 * POSIX, et une copie écrase : « rien d'existant n'est remplacé » ne tenait pas
 * en concurrence (revue passe 6, P1). Un magasin sur un volume sans liens en
 * dur n'importe rien, et le dit (l'erreur du système remonte).
 */
async function installNoReplace(staged: string, dst: string): Promise<void> {
  try {
    await link(staged, dst);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  } finally {
    await rm(staged, { force: true });
  }
}

/**
 * Importe dans le magasin les objets que le git de l'arbre a écrits dans le
 * jetable — sur l'HÔTE, chacun COPIÉ dans l'arrivée en étant VÉRIFIÉ, puis posé
 * sans remplacer : un objet libre doit avoir le nom de son contenu (SHA-1 de
 * `type taille\0contenu`, taille exacte), un paquet doit passer
 * `git verify-pack` — sur la copie de l'arrivée, que rien d'autre n'écrit. Ce
 * que le jetable aurait reçu d'une commande plantée ne peut donc qu'AJOUTER des
 * objets exacts, dans le temps de la borne.
 */
async function importObjects(
  store: string,
  scratch: Scratch,
  incoming: string,
  deadline: HostDeadline,
): Promise<void> {
  const target = join(store, 'store', 'objects');
  for (const dir of await readdir(scratch.objects).catch(() => [] as string[])) {
    if (/^[0-9a-f]{2}$/.test(dir)) {
      for (const name of await readdir(join(scratch.objects, dir))) {
        if (!/^[0-9a-f]{38}$/.test(name)) continue;
        const dst = join(target, dir, name);
        if (existsSync(dst)) continue;
        const staged = join(incoming, dir + name);
        await copyFromScratch(
          join(scratch.objects, dir, name),
          staged,
          'CHECKPOINT_FOREIGN_OBJECT',
          deadline,
          looseObjectCheck(dir + name),
        );
        await mkdir(join(target, dir), { recursive: true });
        await installNoReplace(staged, dst);
      }
    } else if (dir === 'pack') {
      const packDir = join(scratch.objects, 'pack');
      for (const name of await readdir(packDir)) {
        // Le seul nom qu'un git écrit ici ; un autre n'entre pas.
        const m = /^(pack-(?:[0-9a-f]{40}|[0-9a-f]{64}))\.idx$/.exec(name);
        if (!m) continue;
        const base = m[1]!;
        const staged = join(incoming, base);
        for (const ext of ['.pack', '.idx']) {
          await copyFromScratch(
            join(packDir, base + ext),
            staged + ext,
            'CHECKPOINT_FOREIGN_PACK',
            deadline,
          );
        }
        try {
          await run(await gitBinary(), ['verify-pack', `${staged}.idx`], {
            timeout: deadline.remaining(),
            windowsHide: true,
            env: storeEnv(store),
          });
        } catch (err) {
          throw deadline.explain(err);
        }
        await mkdir(join(target, 'pack'), { recursive: true });
        // Le paquet avant son index : git découvre un paquet par son `.idx`.
        await installNoReplace(`${staged}.pack`, join(target, 'pack', `${base}.pack`));
        await installNoReplace(`${staged}.idx`, join(target, 'pack', `${base}.idx`));
      }
    }
  }
}

/** Une entrée d'index, telle que git l'écrit (stage 0, aucun drapeau). */
interface IndexEntry {
  /** ctime, mtime, dev, ino, mode, uid, gid, size : 40 octets, gardés tels quels. */
  readonly stat: Buffer;
  readonly mode: number;
  readonly oid: Buffer;
  readonly path: Buffer;
}

const INDEX_MODES = new Set([0o100644, 0o100755, 0o120000, 0o160000]);

/**
 * Lit un index (versions 2 et 3, SHA-1) et n'en garde que les ENTRÉES — en
 * refusant tout ce qu'un `add -A` honnête n'y pose jamais : une entrée
 * « assume-unchanged » (git ne regarde plus le fichier), « skip-worktree » ou
 * « intent-to-add », un stage de fusion, un mode inconnu, un ordre qui n'est pas
 * celui de git, une extension OBLIGATOIRE (`link`, `sdir` : des entrées
 * ailleurs). Les extensions facultatives (l'arbre en cache, le cache des
 * fichiers non suivis, fsmonitor…) sont des CACHES que git refait : elles sont
 * jetées, et un cache forgé avec elles.
 */
function parseIndex(buf: Buffer): IndexEntry[] {
  const foreign = (why: string): Error => new Error(`CHECKPOINT_FOREIGN_INDEX: ${why}`);
  if (buf.length < 32 || buf.toString('latin1', 0, 4) !== 'DIRC') throw foreign('not an index');
  const body = buf.subarray(0, buf.length - 20);
  if (
    !createHash('sha1')
      .update(body)
      .digest()
      .equals(buf.subarray(buf.length - 20))
  ) {
    throw foreign('its checksum does not match');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw foreign(`version ${version}`);
  const count = buf.readUInt32BE(8);
  const entries: IndexEntry[] = [];
  let off = 12;
  for (let i = 0; i < count; i++) {
    if (off + 62 > body.length) throw foreign('truncated entry');
    const mode = buf.readUInt32BE(off + 24);
    const flags = buf.readUInt16BE(off + 60);
    if (flags & 0x8000) throw foreign('an entry is marked assume-unchanged');
    if ((flags >> 12) & 3) throw foreign('an entry has a merge stage');
    let headerSize = 62;
    if (flags & 0x4000) {
      if (version !== 3) throw foreign('extended flags in a version 2 index');
      if (off + 64 > body.length) throw foreign('truncated entry');
      if (buf.readUInt16BE(off + 62)) throw foreign('an entry is skip-worktree or intent-to-add');
      headerSize = 64;
    }
    const start = off + headerSize;
    const nul = buf.indexOf(0, start);
    if (nul < 0 || nul >= body.length) throw foreign('truncated path');
    const path = buf.subarray(start, nul);
    if ((flags & 0xfff) !== Math.min(path.length, 0xfff)) throw foreign('path length mismatch');
    if (!INDEX_MODES.has(mode)) throw foreign(`mode ${mode.toString(8)}`);
    const previous = entries[entries.length - 1];
    if (previous && Buffer.compare(previous.path, path) >= 0) throw foreign('entries out of order');
    entries.push({
      stat: buf.subarray(off, off + 40),
      mode,
      oid: buf.subarray(off + 40, off + 60),
      path,
    });
    off += (headerSize + path.length + 8) & ~7;
  }
  while (off < body.length) {
    if (off + 8 > body.length) throw foreign('truncated extension');
    const signature = buf.toString('latin1', off, off + 4);
    if (signature[0]! >= 'a' && signature[0]! <= 'z') {
      throw foreign(`it requires the "${signature}" extension`);
    }
    off += 8 + buf.readUInt32BE(off + 4);
  }
  if (off !== body.length) throw foreign('truncated extension');
  return entries;
}

/** Un index de version 2, ces entrées et rien d'autre, sa somme SHA-1 à la fin. */
function writeIndexV2(entries: readonly IndexEntry[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('DIRC', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  parts.push(header);
  for (const e of entries) {
    const size = (62 + e.path.length + 8) & ~7;
    const entry = Buffer.alloc(size);
    e.stat.copy(entry, 0);
    e.oid.copy(entry, 40);
    entry.writeUInt16BE(Math.min(e.path.length, 0xfff), 60);
    e.path.copy(entry, 62);
    parts.push(entry);
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/**
 * Les entrées de `tree`, récursivement : chemin (octets bruts, en latin1) →
 * `mode oid`. Un git du magasin seul, sur l'hôte, borné par `deadline`.
 */
async function treeEntries(
  store: string,
  workspace: string,
  tree: string,
  deadline: HostDeadline,
): Promise<Map<string, string>> {
  const binaire = await gitBinary();
  const child = await hostGit.spawn(binaire, ['ls-tree', '-r', '-z', '--full-tree', tree], {
    env: gitEnv(store, workspace, STORE),
    writableRoots: [],
    readableRoots: [],
  });
  const chunks: Buffer[] = [];
  child.stdout.on('data', (c: Buffer) => chunks.push(c));
  child.stderr.resume();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, deadline.remaining());
  const { code } = await child.closed;
  clearTimeout(timer);
  if (timedOut) throw deadline.explain(Object.assign(new Error('ls-tree'), { killed: true }));
  if (code !== 0) throw new Error(`git ls-tree ${tree} exited with ${code}`);
  const entries = new Map<string, string>();
  for (const record of Buffer.concat(chunks).toString('latin1').split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    const [mode, , oid] = record.slice(0, tab).split(' ');
    entries.set(record.slice(tab + 1), `${mode} ${oid}`);
  }
  return entries;
}

/**
 * Le plus gros index qu'un `add -A` suivi de `write-tree` honnêtes écrivent
 * pour un arbre de ces chemins (octets bruts, en latin1) : l'en-tête et la
 * somme, chaque entrée de version 2 (62 octets, le chemin, le bourrage),
 * l'arbre en cache (`TREE` : par dossier, son nom, `NUL`, deux compteurs et un
 * objet), et une marge pour les petites extensions qu'un git peut ajouter
 * (`EOIE`, `IEOT` : quelques dizaines d'octets). Au-delà, ce n'est pas un index
 * que ce git a écrit pour cet arbre, et il n'est pas lu (revue passe 7, P2) :
 * un index de plusieurs gigaoctets posé dans le jetable tenait l'appel d'outil
 * au-delà de sa borne, ou la mémoire du serveur.
 */
function largestHonestIndex(paths: Iterable<string>): number {
  const EXTENSION_SLACK = 64 * 1024;
  let size = 12 + 20 + EXTENSION_SLACK;
  const dirs = new Set<string>(['']);
  for (const path of paths) {
    size += (62 + path.length + 8) & ~7;
    for (let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) {
      const dir = path.slice(0, i);
      if (dirs.has(dir)) break;
      dirs.add(dir);
    }
  }
  size += 8; // l'en-tête de `TREE`
  for (const dir of dirs) {
    // Le nom, `NUL`, « <entrées> <sous-arbres>\n » (deux nombres de 11
    // caractères au plus, `-1` compris), l'objet.
    size += dir.length - dir.lastIndexOf('/') - 1 + 1 + 24 + 20;
  }
  return size;
}

/**
 * L'index du jetable, lu par l'hôte : une poignée sur un fichier ordinaire
 * (`openScratchFile`), refusé AVANT toute lecture s'il dépasse `max`, puis lu
 * par morceaux dans la borne de temps de la vérification. Un fichier qui
 * grandit pendant la lecture est refusé aussi.
 */
async function readScratchIndex(
  path: string,
  max: number,
  deadline: HostDeadline,
): Promise<{ content: Buffer; mtimeMs: number }> {
  const what = 'CHECKPOINT_FOREIGN_INDEX';
  const handle = await openScratchFile(path, what);
  try {
    const { size, mtimeMs } = await handle.stat();
    if (size > max) {
      throw new Error(
        `${what}: the scratch index is ${size} bytes, more than the ${max} an index of this tree can be`,
      );
    }
    const content = Buffer.alloc(size);
    for (let at = 0; at < size; ) {
      deadline.remaining();
      const { bytesRead } = await handle.read(content, at, Math.min(1024 * 1024, size - at), at);
      if (bytesRead === 0) throw new Error(`${what}: the scratch index shrank while it was read`);
      at += bytesRead;
    }
    const { bytesRead } = await handle.read(Buffer.alloc(1), 0, 1, size);
    if (bytesRead !== 0) throw new Error(`${what}: the scratch index grew while it was read`);
    return { content, mtimeMs };
  } finally {
    await handle.close();
  }
}

/**
 * L'index du jetable devient celui du workspace — mais l'hôte ne le prend pas
 * tel quel (revue passe 6, P1). Le jetable est une racine inscriptible du git
 * de l'arbre, donc de ce que la config d'un sous-dépôt lui fait lancer : un
 * index réécrit là (« assume-unchanged » sur un fichier, une entrée vers un
 * autre contenu) faisait manquer un changement à TOUTES les photos suivantes,
 * et à l'instantané de sûreté d'une restauration.
 *
 * Il est donc lu UNE fois, par l'hôte, sans suivre de lien ; ses entrées
 * doivent être EXACTEMENT celles de l'arbre que cette photo enregistre (mêmes
 * chemins, modes et objets) ; et il est RÉÉCRIT avec elles seules, sans un
 * drapeau ni une extension, daté comme lui. Il n'arrive dans le magasin que par
 * l'arrivée, que seul l'hôte écrit.
 *
 * Ce qui reste hors d'atteinte, et c'est dit : les STATS d'une entrée (date,
 * taille) ne se vérifient pas sans relire le fichier, ce que l'index existe
 * pour éviter. Un processus qui peut écrire le jetable peut aussi écrire le
 * workspace : sous Windows, réécrire un fichier puis lui remettre sa date
 * (`utimes`) le cache déjà à git, sans toucher l'index — la ctime y est la
 * date de création, l'inode est nul.
 */
async function adoptScratchIndex(
  store: string,
  workspace: string,
  scratch: Scratch,
  tree: string,
  incoming: string,
  deadline: HostDeadline,
): Promise<void> {
  const what = 'CHECKPOINT_FOREIGN_INDEX';
  // L'arbre D'ABORD : il dit combien un index honnête peut peser, et l'index
  // n'est lu qu'en deçà (revue passe 7, P2).
  const expected = await treeEntries(store, workspace, tree, deadline);
  const { content, mtimeMs } = await readScratchIndex(
    scratch.index,
    largestHonestIndex(expected.keys()),
    deadline,
  );
  const entries = parseIndex(content);
  if (expected.size !== entries.length) {
    throw new Error(`${what}: ${entries.length} entries for a tree of ${expected.size}`);
  }
  for (const e of entries) {
    const path = e.path.toString('latin1');
    if (expected.get(path) !== `${e.mode.toString(8)} ${e.oid.toString('hex')}`) {
      throw new Error(`${what}: ${e.path.toString('utf8')} is not what the snapshot records`);
    }
  }
  const staged = join(incoming, 'index');
  await writeFile(staged, writeIndexV2(entries), { flag: 'wx' });
  await dateLikeIndex(staged, mtimeMs);
  await rename(staged, join(store, 'indexes', workspaceKey(workspace)));
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
  const incoming = await openWorkDir(store, 'incoming');
  try {
    const wt = onWorktree(scratch);
    await git(store, workspace, ['add', '-A'], wt, undefined, limitMs);
    const tree = await git(store, workspace, ['write-tree'], wt, undefined, limitMs);
    // L'arbre que ce git annonce n'est cru qu'importé, vérifié, et d'un arbre ;
    // son index, que relu et comparé à cet arbre. Chaque vérification de l'hôte
    // a la borne d'une commande git.
    await importObjects(store, scratch, incoming, new HostDeadline(limitMs));
    const kind = await git(store, workspace, ['cat-file', '-t', tree], STORE, undefined, limitMs);
    if (kind !== 'tree') throw new Error(`CHECKPOINT_NOT_A_TREE: ${tree} is a ${kind}`);
    await adoptScratchIndex(store, workspace, scratch, tree, incoming, new HostDeadline(limitMs));

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
    await removeWorkDir(incoming);
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
    // L'ARBRE est écrit par un git qui ne peut écrire que lui et le jetable
    // (voir « Qui lance git »). L'index du jetable n'est PAS gardé (revue passe
    // 6, P1) : celui du magasin reste celui de l'instantané de sûreté, pris
    // juste avant. Les fichiers que la restauration réécrit n'y ont plus leurs
    // stats, donc la photo suivante les relit ; les autres n'ont pas bougé.
    const scratch = await openScratch(store, workspace, true);
    try {
      // -f: the working tree is expected to differ, that is the point.
      await git(store, workspace, ['checkout', '-f', sha, '--', '.'], onWorktree(scratch));
    } finally {
      await closeScratch(scratch);
    }
    return { restored: sha, safety };
  });
}
