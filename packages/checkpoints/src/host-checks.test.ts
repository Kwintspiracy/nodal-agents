// host-checks.test.ts — ce qu'un git de l'arbre laisse dans son JETABLE
// n'entre dans le magasin que vérifié, et lié à ce qui a été vérifié (#628,
// revue passe 6, P1 et P2).
//
// Le jetable est une racine INSCRIPTIBLE du git qui lit l'arbre de travail.
// Ce git lit la config des sous-dépôts du workspace, que le job écrit : ce
// qu'elle lui fait lancer (un `core.fsmonitor` planté) peut réécrire le jetable
// pendant et après lui. Les faux programmes ci-dessous jouent CE processus :
// ils lancent le vrai git, puis touchent le jetable comme il le ferait, avec
// l'environnement exact que Nodal a donné au git (ses chemins de jetable).
//
// Trois choses sortent du jetable, et chacune a ses cas :
//   - les OBJETS (`importObjects`) : nom et octets liés, rien d'existant
//     remplacé, un fichier jamais adopté tel quel (un lien en dur vers un
//     fichier du workspace resterait modifiable), une durée bornée ;
//   - l'INDEX (`adoptScratchIndex`) : relu sur l'hôte, comparé à l'arbre
//     photographié, réécrit sans rien de ce qu'un `add -A` honnête ne pose ;
//   - le jetable lui-même : récolté s'il traîne.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { link, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createDeflate, deflateSync, inflateSync } from 'node:zlib';
import {
  restoreCheckpoint,
  snapshot,
  type CheckpointPrograms,
  type CheckpointProgramOptions,
} from './checkpoints';

const run = promisify(execFile);

let root = '';
let store = '';
let ws = '';
let objects = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nodal-cp-trust-'));
  store = join(root, 'checkpoints');
  ws = join(root, 'workspace');
  objects = join(store, 'store', 'objects');
  await mkdir(ws, { recursive: true });
  await writeFile(join(ws, 'a.txt'), 'one\n');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

type Tamper = (env: NodeJS.ProcessEnv) => Promise<void>;

/**
 * Git sur l'hôte, comme le chemin par défaut ; après la commande `after`, le
 * processus planté touche le jetable (une fois).
 */
function tamperingPrograms(after: string, tamper: Tamper): CheckpointPrograms {
  let done = false;
  const maybe = async (
    args: readonly string[],
    opts: CheckpointProgramOptions | { env?: NodeJS.ProcessEnv },
  ) => {
    if (!done && args[0] === after) {
      done = true;
      await tamper(opts.env ?? {});
    }
  };
  return {
    async execFile(file, args, opts) {
      const r = await run(file, [...args], {
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
        ...(opts.maxBuffer !== undefined ? { maxBuffer: opts.maxBuffer } : {}),
        windowsHide: true,
        env: opts.env,
      });
      await maybe(args, opts);
      return { stdout: String(r.stdout), stderr: String(r.stderr) };
    },
    spawn(file, args, opts) {
      return new Promise((ok, ko) => {
        const child = spawn(file, [...args], { windowsHide: true, env: opts.env });
        const closed = new Promise<{ code: number | null }>((r) =>
          child.on('close', (code) => r({ code })),
        );
        child.once('error', ko);
        child.once('spawn', () => {
          child.off('error', ko);
          child.on('error', () => undefined);
          ok({ stdout: child.stdout, stderr: child.stderr, kill: () => child.kill(), closed });
        });
      });
    },
  };
}

/** Le dossier d'objets du jetable, tel que Nodal l'a donné au git. */
const scratchObjects = (env: NodeJS.ProcessEnv): string => {
  const dir = env['GIT_OBJECT_DIRECTORY'];
  if (!dir) throw new Error('no GIT_OBJECT_DIRECTORY given to the worktree git');
  return dir;
};

/** Un objet libre : ses octets (zlib) et son nom (SHA-1 de `type taille\0contenu`). */
function looseObject(raw: Buffer, level?: number): { name: string; bytes: Buffer } {
  return {
    name: createHash('sha1').update(raw).digest('hex'),
    bytes: deflateSync(raw, level !== undefined ? { level } : {}),
  };
}
const blob = (content: string): Buffer =>
  Buffer.concat([Buffer.from(`blob ${Buffer.byteLength(content)}\0`), Buffer.from(content)]);

async function plantLoose(dir: string, name: string, bytes: Buffer): Promise<string> {
  await mkdir(join(dir, name.slice(0, 2)), { recursive: true });
  const p = join(dir, name.slice(0, 2), name.slice(2));
  await writeFile(p, bytes);
  return p;
}

/** L'objet du magasin a-t-il le nom de ses octets ? */
async function storeObjectHolds(name: string): Promise<string> {
  const raw = inflateSync(await readFile(join(objects, name.slice(0, 2), name.slice(2))));
  return createHash('sha1').update(raw).digest('hex');
}

function gitIn(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', input, windowsHide: true }).trim();
}

/** Un paquet valide d'un seul blob, fabriqué hors du magasin. */
async function makePack(content: string): Promise<{ dir: string; base: string; oid: string }> {
  const repo = join(root, `pack-src-${Math.random().toString(16).slice(2)}`);
  await mkdir(repo, { recursive: true });
  gitIn(repo, ['init', '-q']);
  const oid = gitIn(repo, ['hash-object', '-w', '--stdin'], content);
  const out = join(root, `pack-out-${Math.random().toString(16).slice(2)}`);
  await mkdir(out, { recursive: true });
  const hash = gitIn(repo, ['pack-objects', '-q', join(out, 'pack')], `${oid}\n`);
  return { dir: out, base: `pack-${hash}`, oid };
}

const rejectsWith = (p: Promise<unknown>, text: string) =>
  expect(p).rejects.toMatchObject({ gitMessage: expect.stringContaining(text) });

describe('objects leave the scratch only verified, and bound to what was verified @cap:executer-une-commande/moteur', () => {
  it('un objet libre dont les octets ne hachent pas vers son nom est refusé', async () => {
    const forged = looseObject(blob('forged\n'));
    const wrongName = 'ab' + forged.name.slice(2).replace(/./, (c) => (c === '0' ? '1' : '0'));
    const programs = tamperingPrograms('write-tree', async (env) => {
      await plantLoose(scratchObjects(env), wrongName, forged.bytes);
    });

    await rejectsWith(snapshot(store, ws, 'one', { programs }), 'CHECKPOINT_FOREIGN_OBJECT');
    expect(existsSync(join(objects, wrongName.slice(0, 2), wrongName.slice(2)))).toBe(false);
  });

  it('un objet dont l’en-tête annonce une autre taille que son contenu est refusé', async () => {
    // Le nom est bien le SHA-1 de ces octets : seule la taille ment.
    const lying = looseObject(Buffer.concat([Buffer.from('blob 99\0'), Buffer.from('short\n')]));
    const programs = tamperingPrograms('write-tree', async (env) => {
      await plantLoose(scratchObjects(env), lying.name, lying.bytes);
    });

    await rejectsWith(snapshot(store, ws, 'one', { programs }), 'CHECKPOINT_FOREIGN_OBJECT');
    expect(existsSync(join(objects, lying.name.slice(0, 2), lying.name.slice(2)))).toBe(false);
  });

  it('un objet lié en dur depuis le workspace n’est pas adopté : le magasin garde les octets vérifiés', async () => {
    // Le processus planté écrit un objet VALIDE dans le workspace, et le lie en
    // dur dans le jetable. Adopter le fichier (renommage) ferait de l'objet du
    // magasin ce fichier-là, que le workspace réécrit ensuite à volonté.
    const obj = looseObject(blob('planted, valid\n'));
    const inWorkspace = join(ws, 'object.raw');
    const programs = tamperingPrograms('write-tree', async (env) => {
      await writeFile(inWorkspace, obj.bytes);
      await mkdir(join(scratchObjects(env), obj.name.slice(0, 2)), { recursive: true });
      await link(inWorkspace, join(scratchObjects(env), obj.name.slice(0, 2), obj.name.slice(2)));
    });

    expect(await snapshot(store, ws, 'one', { programs })).not.toBeNull();
    expect(await storeObjectHolds(obj.name)).toBe(obj.name);

    // Réécrit EN PLACE (même fichier) : un objet adopté changerait avec lui.
    await writeFile(inWorkspace, deflateSync(blob('rewritten afterwards\n')));
    expect(await storeObjectHolds(obj.name), 'the store object followed the workspace file').toBe(
      obj.name,
    );
  });

  it('un objet déjà dans le magasin n’est jamais remplacé, même par les mêmes octets décompressés', async () => {
    const first = await snapshot(store, ws, 'one');
    expect(first).not.toBeNull();
    const name = gitIn(ws, ['hash-object', 'a.txt']);
    const path = join(objects, name.slice(0, 2), name.slice(2));
    const before = await readFile(path);
    // Le même objet, stocké sans compression : même nom, autres octets.
    const other = looseObject(blob('one\n'), 0);
    expect(other.name).toBe(name);
    expect(other.bytes.equals(before)).toBe(false);

    await writeFile(join(ws, 'b.txt'), 'two\n');
    const programs = tamperingPrograms('write-tree', async (env) => {
      await plantLoose(scratchObjects(env), name, other.bytes);
    });
    expect(await snapshot(store, ws, 'two', { programs })).not.toBeNull();
    expect((await readFile(path)).equals(before)).toBe(true);
  });

  it('un paquet corrompu est refusé, et rien n’en entre dans le magasin', async () => {
    const programs = tamperingPrograms('write-tree', async (env) => {
      const dir = join(scratchObjects(env), 'pack');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'pack-0000000000000000000000000000000000000000.idx'), 'not an idx');
      await writeFile(
        join(dir, 'pack-0000000000000000000000000000000000000000.pack'),
        'not a pack',
      );
    });

    await expect(snapshot(store, ws, 'one', { programs })).rejects.toBeTruthy();
    const packs = await readdir(join(objects, 'pack')).catch(() => [] as string[]);
    expect(packs.filter((f) => f.startsWith('pack-0000'))).toEqual([]);
  });

  it('un paquet lié en dur depuis le workspace n’est pas adopté : le magasin garde le paquet vérifié', async () => {
    const pack = await makePack('packed, valid\n');
    const programs = tamperingPrograms('write-tree', async (env) => {
      const dir = join(scratchObjects(env), 'pack');
      await mkdir(dir, { recursive: true });
      for (const ext of ['.pack', '.idx']) {
        const inWorkspace = join(ws, `planted${ext}`);
        await writeFile(inWorkspace, await readFile(join(pack.dir, pack.base + ext)));
        await link(inWorkspace, join(dir, pack.base + ext));
      }
    });

    expect(await snapshot(store, ws, 'one', { programs })).not.toBeNull();
    const installed = join(objects, 'pack', `${pack.base}.idx`);
    expect(existsSync(installed)).toBe(true);

    // Le workspace réécrit son paquet en place : celui du magasin ne bouge pas.
    await writeFile(join(ws, 'planted.pack'), Buffer.alloc(64, 7));
    const { stdout } = await run('git', ['verify-pack', installed], { windowsHide: true });
    expect(stdout).toBe('');
  });

  it('l’import est borné par la borne de l’instantané : une bombe zlib le fait échouer, fort', async () => {
    // 2 Gio de zéros : environ 2 Mo compressés, un objet VALIDE (son nom est le
    // SHA-1 de son contenu). Le décompresser et le hacher prend des secondes.
    const size = 2 * 1024 * 1024 * 1024;
    const header = Buffer.from(`blob ${size}\0`);
    const hash = createHash('sha1').update(header);
    const deflate = createDeflate({ level: 1 });
    const parts: Buffer[] = [];
    deflate.on('data', (c: Buffer) => parts.push(c));
    const ended = new Promise((r) => deflate.on('end', r));
    deflate.write(header);
    const zeros = Buffer.alloc(16 * 1024 * 1024);
    for (let i = 0; i < size / zeros.length; i++) {
      hash.update(zeros);
      if (!deflate.write(zeros)) await new Promise((r) => deflate.once('drain', r));
    }
    deflate.end();
    await ended;
    const name = hash.digest('hex');
    const bytes = Buffer.concat(parts);
    const programs = tamperingPrograms('write-tree', async (env) => {
      await plantLoose(scratchObjects(env), name, bytes);
    });

    const err = await snapshot(store, ws, 'one', { programs, timeoutMs: 600 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err, 'the import of a zlib bomb finished: it has no bound').toMatchObject({
      code: 'snapshot_timeout',
    });
    expect(existsSync(join(objects, name.slice(0, 2), name.slice(2)))).toBe(false);
  }, 60_000);
});

describe('the scratch index enters the store only checked against the snapshot and rewritten @cap:executer-une-commande/moteur', () => {
  const indexFiles = async (): Promise<string[]> =>
    (await readdir(join(store, 'indexes'))).filter((f) => !f.includes('.'));

  it('un index marqué « assume-unchanged » par le processus planté est refusé, et l’index du magasin reste le bon', async () => {
    expect(await snapshot(store, ws, 'zero')).not.toBeNull();
    const [key] = await indexFiles();
    const good = await readFile(join(store, 'indexes', key!));

    await writeFile(join(ws, 'b.txt'), 'b\n');
    const programs = tamperingPrograms('write-tree', async (env) => {
      execFileSync('git', ['update-index', '--assume-unchanged', 'a.txt'], {
        cwd: ws,
        env,
        windowsHide: true,
      });
    });
    await rejectsWith(snapshot(store, ws, 'one', { programs }), 'CHECKPOINT_FOREIGN_INDEX');
    expect((await readFile(join(store, 'indexes', key!))).equals(good)).toBe(true);

    // Et la photo suivante voit un changement d'a.txt.
    await writeFile(join(ws, 'a.txt'), 'changed, longer\n');
    const next = await snapshot(store, ws, 'two');
    expect(next).not.toBeNull();
    expect(gitIn(ws, ['--git-dir', join(store, 'store'), 'show', `${next!.sha}:a.txt`])).toBe(
      'changed, longer',
    );
  });

  it('un index dont une entrée ne correspond pas à l’arbre photographié est refusé', async () => {
    const other = gitIn(ws, ['hash-object', '-w', '--stdin'], 'elsewhere\n');
    const programs = tamperingPrograms('write-tree', async (env) => {
      execFileSync('git', ['update-index', '--cacheinfo', `100644,${other},a.txt`], {
        cwd: ws,
        env,
        windowsHide: true,
      });
    });

    await rejectsWith(snapshot(store, ws, 'one', { programs }), 'CHECKPOINT_FOREIGN_INDEX');
  });

  it('un index honnête est gardé, sans les extensions qu’un processus planté pourrait forger', async () => {
    expect(await snapshot(store, ws, 'one')).not.toBeNull();
    const [key] = await indexFiles();
    const index = await readFile(join(store, 'indexes', key!));
    expect(index.subarray(0, 4).toString()).toBe('DIRC');
    expect(index.readUInt32BE(4)).toBe(2);
    expect(index.readUInt32BE(8)).toBe(1);
    // Une entrée de 62 octets + « a.txt » + bourrage = 72, puis la somme : rien entre.
    expect(index.length).toBe(12 + 72 + 20);
    const body = index.subarray(0, index.length - 20);
    expect(createHash('sha1').update(body).digest().equals(index.subarray(-20))).toBe(true);
  });

  it('l’index repris du jetable garde la date que git lui a donnée : une réécriture du même tic reste vue', async () => {
    // Le git du jetable écrit l'index dans le même tic que le fichier : son
    // entrée est racy. L'index réécrit par l'hôte doit le rester (voir
    // racy-index.test.ts pour la ctime et l'inode écartés).
    const T = Math.floor(Date.now() / 1000) - 120;
    const file = join(ws, 'image.bin');
    await writeFile(file, 'AAAA');
    await utimes(file, T, T);
    const programs = tamperingPrograms('write-tree', async (env) => {
      await utimes(env['GIT_INDEX_FILE']!, T, T);
    });
    expect(await snapshot(store, ws, 'one', { programs })).not.toBeNull();

    await writeFile(
      join(store, 'gitconfig'),
      '[core]\n\ttrustctime = false\n\tcheckStat = minimal\n',
    );
    await writeFile(file, 'BBBB');
    await utimes(file, T, T);
    const two = await snapshot(store, ws, 'two');
    expect(two, 'the adopted index lost the date git gave it').not.toBeNull();
    expect(gitIn(ws, ['--git-dir', join(store, 'store'), 'show', `${two!.sha}:image.bin`])).toBe(
      'BBBB',
    );
  });

  it('restoreCheckpoint ne garde pas l’index du jetable : un « assume-unchanged » planté ne cache rien à la photo suivante', async () => {
    const first = await snapshot(store, ws, 'one');
    expect(first).not.toBeNull();
    await writeFile(join(ws, 'a.txt'), 'two\n');

    const programs = tamperingPrograms('checkout', async (env) => {
      execFileSync('git', ['update-index', '--assume-unchanged', 'a.txt'], {
        cwd: ws,
        env,
        windowsHide: true,
      });
    });
    await restoreCheckpoint(store, ws, first!.sha, programs);
    expect(await readFile(join(ws, 'a.txt'), 'utf8')).toBe('one\n');

    await writeFile(join(ws, 'a.txt'), 'three, longer\n');
    const after = await snapshot(store, ws, 'after');
    expect(after, 'the planted assume-unchanged hid the change').not.toBeNull();
    expect(gitIn(ws, ['--git-dir', join(store, 'store'), 'show', `${after!.sha}:a.txt`])).toBe(
      'three, longer',
    );
  });
});

describe('scratch and incoming folders are reaped when an operation leaves them @cap:executer-une-commande/moteur', () => {
  it('un jetable de plus d’un jour est retiré à l’opération suivante ; un jetable récent est laissé', async () => {
    await snapshot(store, ws, 'first');
    const day = 24 * 60 * 60 * 1000;
    const old = `${Date.now() - day - 60_000}-0123456789abcdef`;
    const fresh = `${Date.now()}-fedcba9876543210`;
    for (const kind of ['scratch', 'incoming']) {
      for (const name of [old, fresh]) {
        await mkdir(join(store, kind, name, 'objects'), { recursive: true });
        await writeFile(join(store, kind, name, 'index'), 'left behind');
      }
    }

    await writeFile(join(ws, 'b.txt'), 'b\n');
    expect(await snapshot(store, ws, 'second')).not.toBeNull();

    for (const kind of ['scratch', 'incoming']) {
      const left = await readdir(join(store, kind));
      expect(left, `${kind}: the day-old folder was not reaped`).not.toContain(old);
      expect(left, `${kind}: a live folder was reaped`).toContain(fresh);
    }
  });
});
