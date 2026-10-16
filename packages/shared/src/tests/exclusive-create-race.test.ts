// exclusive-create-race.test.ts — le nom temporaire de createFileExclusive vit
// dans un dossier que des commandes confinées écrivent. Si l'une d'elles le
// remplace entre l'écriture et `link()`, le helper ne doit PAS rendre un succès
// pour un fichier qui n'est pas celui qu'il a écrit (revue de la PR #763, P2).
//
// Fichier à part : `link` y est enveloppé pour jouer l'adversaire PILE entre
// l'écriture et la liaison, ce que les autres cas ne doivent pas subir.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hook = vi.hoisted(() => ({
  beforeLink: undefined as undefined | ((staged: string) => Promise<void>),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    link: async (existing: string, target: string): Promise<void> => {
      await hook.beforeLink?.(existing);
      return real.link(existing, target);
    },
  };
});

const { createFileExclusive, EXCLUSIVE_CREATE_SUBSTITUTED } = await import('../exclusive-create');

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nodal-exclusive-race-'));
});
afterEach(async () => {
  hook.beforeLink = undefined;
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('createFileExclusive — the staging name is replaced before link() @cap:travailler-sur-des-fichiers/moteur', () => {
  it('never reports success for a file that is not the one it wrote, and leaves no entry at the path', async () => {
    const adversaire = join(dir, 'adversaire.txt');
    await writeFile(adversaire, 'CONTENU DE L’ADVERSAIRE');
    let replaced = false;
    hook.beforeLink = async (staged) => {
      try {
        // Ce qu'une commande confinée qui boucle sur le dossier peut faire.
        await rename(adversaire, staged);
        replaced = true;
      } catch {
        // Sous Windows, la poignée que le helper garde ouverte interdit de
        // remplacer le nom temporaire : l'attaque n'a pas lieu.
      }
    };
    const cible = join(dir, '.gitignore');

    let error: NodeJS.ErrnoException | undefined;
    try {
      await createFileExclusive(cible, 'ÉCRIT PAR L’HÔTE');
    } catch (e) {
      error = e as NodeJS.ErrnoException;
    }

    if (replaced) {
      expect(error?.code).toBe(EXCLUSIVE_CREATE_SUBSTITUTED);
      // Rien n'est resté au chemin voulu, ni de nom temporaire.
      expect((await readdir(dir)).sort()).toEqual([]);
    } else {
      expect(error).toBeUndefined();
      expect(await readFile(cible, 'utf8')).toBe('ÉCRIT PAR L’HÔTE');
      expect((await readdir(dir)).sort()).toEqual(['.gitignore', 'adversaire.txt']);
    }
  });
});
