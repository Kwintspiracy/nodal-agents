// frozen-index.test.ts — la lecture d'un instantané figé dit POURQUOI elle
// n'a pas de réponse (#590, revue A de #591, passe 2).
//
// Un `catch` unique rendait la même raison pour un git absent, une borne de
// temps dépassée, une sortie trop longue et un index que git refuse. Ce ne sont
// pas les mêmes gestes pour le propriétaire.
//
// Les pannes sont provoquées comme dans `failure-timeout.test.ts` : `execFile`
// est détourné, à la demande, vers un programme qui pend, qui déborde, ou qui
// n'existe pas. La machinerie de Node est intacte : c'est elle qui tue l'enfant
// à la borne ou au-delà du tampon, et qui rend l'erreur que le code classe.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Le commutateur, hissé pour que la fabrique du mock puisse le lire. */
const etat = vi.hoisted(() => ({ mode: 'reel' as 'reel' | 'pend' | 'deborde' | 'absent' }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');

  /** Un enfant qui ne rend JAMAIS la main. */
  const PEND = ['-e', 'setInterval(() => {}, 1000);'];
  /** Un enfant qui écrit plus que le tampon accepté (16 Mo). */
  const DEBORDE = ['-e', "process.stdout.write('x'.repeat(17 * 1024 * 1024));"];

  type Rappel = (err: unknown, stdout: string, stderr: string) => void;
  const execFile = actual.execFile as never as (...a: unknown[]) => unknown;
  const lancer = (file: string, args: unknown, options: unknown, cb: Rappel): unknown => {
    if (etat.mode === 'pend') return execFile(process.execPath, PEND, options, cb);
    if (etat.mode === 'deborde') return execFile(process.execPath, DEBORDE, options, cb);
    if (etat.mode === 'absent') return execFile(`${file}-introuvable`, args, options, cb);
    return execFile(file, args, options, cb);
  };
  const faux = ((...a: unknown[]) =>
    lancer(a[0] as string, a[1], a[2], a[3] as Rappel)) as unknown as typeof actual.execFile;
  Object.defineProperty(faux, promisify.custom, {
    value: (file: string, args: unknown, options: unknown) =>
      new Promise((resolve, reject) => {
        lancer(file, args, options, (err, stdout, stderr) => {
          if (err) reject(Object.assign(err as object, { stdout, stderr }));
          else resolve({ stdout, stderr });
        });
      }),
  });
  return { ...actual, execFile: faux };
});

import {
  freezeSnapshotIndex,
  releaseFrozenIndex,
  snapshot,
  statusAgainstFrozenIndex,
} from './checkpoints';

/** Large devant le temps de tuer un processus, minuscule devant l'éternité. */
const BORNE_MS = 200;

let root: string;
let store: string;
let ws: string;
let indexFile: string;

beforeEach(async () => {
  etat.mode = 'reel';
  root = await mkdtemp(join(tmpdir(), 'nodal-fige-'));
  store = join(root, 'store');
  ws = join(root, 'ws');
  await (await import('node:fs/promises')).mkdir(ws);
  await writeFile(join(ws, 'a.txt'), 'a');
  await snapshot(store, ws, 'le tour');
  const fige = await freezeSnapshotIndex(store, ws);
  if (fige.kind !== 'frozen') throw new Error(`gel impossible : ${fige.reason}`);
  indexFile = fige.indexFile;
  process.env['NODALAI_CHECKPOINT_TIMEOUT_MS'] = String(BORNE_MS);
});

afterEach(async () => {
  etat.mode = 'reel';
  delete process.env['NODALAI_CHECKPOINT_TIMEOUT_MS'];
  await releaseFrozenIndex(indexFile);
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

describe('statusAgainstFrozenIndex names each cause @cap:travailler-sur-des-fichiers/moteur', () => {
  it('a real read answers the status', async () => {
    await writeFile(join(ws, 'b.txt'), 'b');
    const lu = await statusAgainstFrozenIndex(store, ws, indexFile);
    expect(lu.kind).toBe('status');
    if (lu.kind === 'status') expect(lu.stdout).toContain('?? b.txt');
  });

  it('git that hangs past the bound is snapshot_status_timeout', async () => {
    etat.mode = 'pend';
    expect(await statusAgainstFrozenIndex(store, ws, indexFile)).toEqual({
      kind: 'failed',
      reason: 'snapshot_status_timeout',
    });
  });

  it('an output longer than the buffer is snapshot_status_too_large, not a timeout', async () => {
    etat.mode = 'deborde';
    expect(await statusAgainstFrozenIndex(store, ws, indexFile)).toEqual({
      kind: 'failed',
      reason: 'snapshot_status_too_large',
    });
  });

  it('a git that cannot be launched is git_missing', async () => {
    etat.mode = 'absent';
    expect(await statusAgainstFrozenIndex(store, ws, indexFile)).toEqual({
      kind: 'failed',
      reason: 'git_missing',
    });
  });

  it('an index git refuses is snapshot_status_failed', async () => {
    await writeFile(indexFile, 'pas un index git');
    expect(await statusAgainstFrozenIndex(store, ws, indexFile)).toEqual({
      kind: 'failed',
      reason: 'snapshot_status_failed',
    });
  });
});

describe('freezeSnapshotIndex @cap:travailler-sur-des-fichiers/moteur', () => {
  it('copies the index with its date, and leaves nothing behind once released', async () => {
    const indexes = join(store, 'indexes');
    const { stat } = await import('node:fs/promises');
    const [source] = (await readdir(indexes)).filter((f) => !f.includes('.constat-'));
    const original = await stat(join(indexes, source!));
    const copie = await stat(indexFile);
    expect(copie.size).toBe(original.size);
    // La date de l'original, arrondie vers le bas à la milliseconde.
    expect(copie.mtimeMs).toBeLessThanOrEqual(original.mtimeMs);
    expect(copie.mtimeMs).toBeGreaterThan(original.mtimeMs - 1);
    await releaseFrozenIndex(indexFile);
    expect(await readdir(indexes)).toEqual([source]);
  });
});
