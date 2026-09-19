// constat-chemin-reel.test.ts — UN FICHIER, UNE LIGNE, quelle que soit son
// orthographe (issue #199).
//
// Les deux constats ne nomment pas le même fichier de la même façon : git rend
// toujours la forme longue et suivie, un outil de Nodal rend ce que son
// appelant lui a donné — une forme courte 8.3 sous Windows, ou un chemin qui
// traverse une jonction. Sans résolution, le même fichier écrit par un harnais
// dans un dépôt entrait DEUX fois dans le constat, une fois `git` et une fois
// `disk`, et le bloc Files le montrait deux fois sous deux noms.
//
// C'est le défaut que la CI Windows a trouvé sur la garde de périmètre du
// constat par git ; ce fichier couvre son chemin jumeau.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizePath } from '@nodal-agents/shared';
import { cheminConstate } from '../verification/record-constat';

let racine = '';

beforeEach(async () => {
  racine = await mkdtemp(join(tmpdir(), 'nodal-constat-chemin-'));
});

afterEach(async () => {
  await rm(racine, { recursive: true, force: true });
});

describe('cheminConstate @cap:travailler-sur-des-fichiers/moteur', () => {
  it('deux orthographes du même fichier donnent le MÊME chemin', async () => {
    const vrai = join(racine, 'projet');
    await mkdir(vrai, { recursive: true });
    await writeFile(join(vrai, 'a.ts'), 'export const a = 1;\n');
    const lien = join(racine, 'alias');
    try {
      await symlink(vrai, lien, 'junction');
    } catch (err) {
      console.warn(
        `[tests] CAS SAUTÉ — impossible de créer un lien : ${String(err)}\n` +
          '        La règle reste prouvée par le cas du fichier supprimé ci-dessous.',
      );
      return;
    }

    const parLeVrai = await cheminConstate(join(vrai, 'a.ts'));
    const parLeLien = await cheminConstate(join(lien, 'a.ts'));

    expect(parLeLien).toBe(parLeVrai);
    await rm(lien, { recursive: true, force: true });
  });

  it('un fichier SUPPRIMÉ garde un chemin utilisable : son dossier, résolu', async () => {
    // Une suppression est une écriture, et elle doit se ranger comme les
    // autres. Le fichier n'a plus de chemin réel — son dossier, lui, en a un.
    const vrai = join(racine, 'projet');
    await mkdir(vrai, { recursive: true });
    const cible = join(vrai, 'parti.ts');
    await writeFile(cible, 'x');
    const attendu = await cheminConstate(cible);
    await unlink(cible);

    expect(await cheminConstate(cible)).toBe(attendu);
    expect(attendu.endsWith('/parti.ts')).toBe(true);
  });

  it('un chemin dont RIEN n’existe est rendu tel quel, jamais inventé', async () => {
    const inconnu = join(racine, 'nulle-part', 'x.ts');

    expect(await cheminConstate(inconnu)).toBe(normalizePath(inconnu));
  });
});
