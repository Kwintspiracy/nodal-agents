// exclusive-create.test.ts — createFileExclusive refuse tout ce qui existe déjà
// à son chemin, lien pendant compris, SUR CHAQUE SYSTÈME. Le cas du lien est le
// seul qui sépare le drapeau `wx` de cette fonction : sous Windows, `wx` suit un
// lien pendant et crée sa cible (project-git.test.ts, runner Windows Server).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileExclusive } from '../exclusive-create';

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nodal-exclusive-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code;
  }
};

describe('createFileExclusive @cap:travailler-sur-des-fichiers/moteur', () => {
  it('creates the file with the given content and leaves nothing else in the folder', async () => {
    await createFileExclusive(join(dir, 'a.txt'), 'bonjour\n');
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('bonjour\n');
    expect(await readdir(dir)).toEqual(['a.txt']);
  });

  it('writes bytes as given', async () => {
    await createFileExclusive(join(dir, 'b.bin'), new Uint8Array([0, 1, 2, 255]));
    expect([...(await readFile(join(dir, 'b.bin')))]).toEqual([0, 1, 2, 255]);
  });

  it('refuses an existing file with EEXIST and does not touch its content', async () => {
    await writeFile(join(dir, 'c.txt'), 'à moi');
    expect(await codeOf(createFileExclusive(join(dir, 'c.txt'), 'autre'))).toBe('EEXIST');
    expect(await readFile(join(dir, 'c.txt'), 'utf8')).toBe('à moi');
    expect(await readdir(dir)).toEqual(['c.txt']);
  });

  it('refuses an existing folder with EEXIST', async () => {
    await mkdir(join(dir, 'd'));
    expect(await codeOf(createFileExclusive(join(dir, 'd'), 'x'))).toBe('EEXIST');
    expect(await readdir(dir)).toEqual(['d']);
  });

  it('refuses a DANGLING symbolic link with EEXIST and never creates its target', async () => {
    const cible = join(dir, 'hors-du-projet.txt');
    try {
      await symlink(cible, join(dir, 'lien'), 'file');
    } catch (e) {
      // Sous Windows, créer un lien symbolique demande un privilège (ou le mode
      // développeur) : sans lui, une commande confinée ne peut pas en poser non
      // plus, et le cas ne se joue pas. Dit, pas sauté en silence. Le runner
      // Windows de la CI l'a, et c'est lui qui prouve le cas.
      expect((e as NodeJS.ErrnoException).code, String(e)).toBe('EPERM');
      return;
    }
    expect(await codeOf(createFileExclusive(join(dir, 'lien'), 'x'))).toBe('EEXIST');
    expect(existsSync(cible), 'the planted link was followed: a file was written').toBe(false);
  });
});
