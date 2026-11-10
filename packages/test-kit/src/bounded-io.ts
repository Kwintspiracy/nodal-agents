// bounded-io.ts — faire N opérations de disque SANS les lancer toutes à la fois.
//
// Le motif qu'il remplace : `await Promise.all(items.map(… writeFile …))` avec
// N de l'ordre du millier. Mille et une écritures simultanées demandent à
// l'ordonnanceur d'un runner Windows chargé (antivirus qui lit chaque fichier
// neuf) une équité qu'il ne promet pas : le cas « un arbre plus sale que la
// borne » de `git-constat.test.ts` a pris 60 s une fois sur quatre, contre 0,9
// à 2,4 s d'habitude (issue #1034). Le même motif avait déjà coûté une minute
// à `inbound-files.test.ts` (600 dossiers) et à `constat-fallback.test.ts`.
//
// Une file de `concurrency` opérations en vol : le débit est celui du disque,
// pas celui de la file d'attente de libuv, et la durée croît de façon
// prévisible avec N au lieu de basculer.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Opérations en vol en même temps. Assez pour occuper le disque, pas pour l'affamer. */
export const BOUNDED_IO_CONCURRENCY = 32;

function checkConcurrency(concurrency: number): void {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`bounded-io: concurrency must be a positive integer, got ${concurrency}`);
  }
}

/**
 * `Promise.all(items.map(fn))` avec au plus `concurrency` appels en vol. Rend
 * les résultats dans l'ordre de `items`. Le premier rejet arrête la
 * distribution (les appels déjà en vol finissent) et rejette le tout : un test
 * qui n'a pas pu préparer son arbre ne continue pas sur un arbre à moitié rempli.
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number = BOUNDED_IO_CONCURRENCY,
): Promise<R[]> {
  checkConcurrency(concurrency);
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i] as T, i);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

export interface WriteManyFilesOptions {
  /** Écritures simultanées (défaut `BOUNDED_IO_CONCURRENCY`). */
  concurrency?: number;
  /** Nom du fichier `i`, relatif à `dir` (défaut `f<i>.txt`). Peut porter des sous-dossiers. */
  nameOf?: (i: number) => string;
  /** Contenu du fichier `i` (défaut `<i>\n`). */
  contentOf?: (i: number) => string;
}

/**
 * Écrit `count` fichiers dans `dir` (créé au besoin), au plus `concurrency` à
 * la fois. Rend les chemins écrits, dans l'ordre de `i`.
 */
export async function writeManyFiles(
  dir: string,
  count: number,
  options: WriteManyFilesOptions = {},
): Promise<string[]> {
  const nameOf = options.nameOf ?? ((i: number) => `f${i}.txt`);
  const contentOf = options.contentOf ?? ((i: number) => `${i}\n`);
  await mkdir(dir, { recursive: true });
  return mapBounded(
    Array.from({ length: count }, (_, i) => i),
    async (i) => {
      const path = join(dir, nameOf(i));
      // Un nom à sous-dossier (`a/b.txt`) : le dossier est créé, pas supposé.
      if (dirname(path) !== dir) await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contentOf(i));
      return path;
    },
    options.concurrency,
  );
}
