// racy-index.test.ts — une réécriture de MÊME TAILLE dans le MÊME tic d'horloge
// que l'index reste vue, par TOUT ce qui lit l'arbre à travers une copie de
// l'index du workspace (#628, CI rouge sur 71fb7bca).
//
// Git ne relit le contenu d'une entrée que si elle est « racy » : datée au
// plus tard de l'écriture de l'index (racy-git.txt). Sinon il croit la date et
// la taille. Le jetable COPIAIT l'index du workspace avec `copyFile`. Sous
// Windows, CopyFileW garde la date de la source, et rien ne se voyait ; ailleurs
// (libuv : copy_file_range / sendfile), la copie est datée de maintenant :
// toutes les entrées devenaient « propres », et une réécriture de même taille
// dans le même tic que la photo d'avant passait inaperçue. Une photo manquée,
// et une restauration qui ne réécrit pas un fichier qu'elle croit intact.
//
// Le cas est rendu racy EXPRÈS, sur tous les systèmes : même taille, même
// mtime à la seconde entière pour le fichier, et l'index du workspace daté de
// ce même instant. La ctime et l'inode sont écartés (`trustctime = false`,
// `checkStat = minimal`, dans la config du magasin de CE test) : sous Linux ils
// changent à la réécriture et sauveraient git par hasard. Seule reste la
// protection « racy », celle que la copie doit garder.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  freezeSnapshotIndex,
  releaseFrozenIndex,
  restoreCheckpoint,
  snapshot,
  statusAgainstFrozenIndex,
} from './checkpoints';

let root = '';
let store = '';
let ws = '';
let file = '';
/** L'instant commun du fichier et de l'index : deux minutes dans le passé. */
let T = 0;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nodal-racy-'));
  store = join(root, 'store');
  ws = join(root, 'ws');
  file = join(ws, 'image.bin');
  T = Math.floor(Date.now() / 1000) - 120;
  await mkdir(ws, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Photographie `AAAA` daté de T, puis la réécrit en `BBBB` dans le même tic que l'index. */
async function sameTickRewrite(): Promise<string> {
  await writeFile(file, 'AAAA');
  await utimes(file, T, T);
  const one = await snapshot(store, ws, 'one');
  expect(one).not.toBeNull();

  // Seules la taille et la date entière comptent ; la ctime n'aide pas git.
  await writeFile(
    join(store, 'gitconfig'),
    '[core]\n\ttrustctime = false\n\tcheckStat = minimal\n',
  );
  // L'index du workspace, daté du même instant que l'entrée : elle est racy.
  const indexes = (await readdir(join(store, 'indexes'))).filter((f) => !f.includes('.'));
  expect(indexes).toHaveLength(1);
  await utimes(join(store, 'indexes', indexes[0]!), T, T);

  // Même taille, même date : seul le contenu a changé.
  await writeFile(file, 'BBBB');
  await utimes(file, T, T);
  return one!.sha;
}

function showInStore(rev: string): string {
  return execFileSync('git', ['show', rev], {
    env: { ...process.env, GIT_DIR: join(store, 'store') },
    encoding: 'utf8',
  });
}

describe('a copy of the workspace index keeps git racy-clean protection @cap:travailler-sur-des-fichiers/moteur', () => {
  it('snapshot : la réécriture de même taille est photographiée', async () => {
    await sameTickRewrite();

    const two = await snapshot(store, ws, 'two');
    expect(two, 'the same-size rewrite was missed: the scratch index lost racy-git').not.toBeNull();
    expect(showInStore(`${two!.sha}:image.bin`)).toBe('BBBB');
  });

  it('restoreCheckpoint : le fichier réécrit est bien remis, et la réécriture gardée en sûreté', async () => {
    const one = await sameTickRewrite();

    const { safety } = await restoreCheckpoint(store, ws, one);
    expect(await readFile(file, 'utf8'), 'restore skipped a file it took for intact').toBe('AAAA');
    expect(safety, 'the safety snapshot missed the same-size rewrite').not.toBeNull();
    expect(showInStore(`${safety!.sha}:image.bin`)).toBe('BBBB');
  });

  it('statusAgainstFrozenIndex : la copie figée voit la réécriture', async () => {
    await sameTickRewrite();

    const frozen = await freezeSnapshotIndex(store, ws);
    expect(frozen.kind).toBe('frozen');
    if (frozen.kind !== 'frozen') return;
    try {
      const status = await statusAgainstFrozenIndex(store, ws, frozen.indexFile);
      expect(status.kind).toBe('status');
      if (status.kind !== 'status') return;
      // Colonne de gauche : `A` (le magasin n'a pas de HEAD) ; de droite : `M`.
      expect(status.stdout.split('\0')).toContain('AM image.bin');
    } finally {
      await releaseFrozenIndex(frozen.indexFile);
    }
  });
});
