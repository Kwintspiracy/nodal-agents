// file-list-root-form.test.ts — le nom des entrées quand la racine déclarée et
// la racine résolue ne s'écrivent pas pareil.
//
// Trouvé par le job Windows de la CI, jamais par une machine de dev : le
// runner tourne sous l'utilisateur `runneradmin` (11 caractères), donc son
// dossier temporaire a une forme courte 8.3 distincte de sa forme longue.
// `file_list` renvoyait alors des noms comme
// `../../../../../runneradmin/AppData/Local/Temp/ws/sub/note.md` au lieu de
// `sub/note.md`.
//
// La cause n'est pas Windows : `resolveAndCheckPath` rend un chemin REALPATHÉ
// (workspace.ts résout la racine pour fermer les évasions par lien
// symbolique), tandis que la racine d'affichage vient de la configuration
// telle qu'elle a été saisie. Dès que les deux formes du même dossier
// diffèrent, `relative()` sort de l'arborescence. macOS a exactement le même
// problème — `/var` y est un lien vers `/private/var`.
//
// Ce test le reproduit partout, avec un lien symbolique : la racine déclarée
// passe par le lien, les fichiers sont lus derrière. Si le lien ne peut pas
// être créé (Windows sans privilège), on le dit et on saute — un test qui se
// tait quand il n'a rien vérifié est pire qu'absent.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileListTool } from '../builtin/file-ops/file-list';
import type { ToolContext } from '../types';

let base = '';
let reel = '';
let parLien = '';
let lienUtilisable = true;

function ctxWith(root: string): ToolContext {
  return {
    jobId: '00000000-0000-4000-8000-000000000001',
    agentId: '00000000-0000-4000-8000-000000000002',
    entityId: '00000000-0000-4000-8000-000000000003',
    jobChatId: null,
    db: null as never,
    workspaces: [{ label: 'ws', path: root }],
  } as unknown as ToolContext;
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'nodal-rootform-')));
  reel = join(base, 'reel');
  await mkdir(join(reel, 'sub'), { recursive: true });
  await writeFile(join(reel, 'top.md'), '');
  await writeFile(join(reel, 'sub', 'nested.md'), '');

  parLien = join(base, 'via-lien');
  try {
    await symlink(reel, parLien, 'junction');
  } catch {
    lienUtilisable = false;
  }
});

afterAll(async () => {
  if (base) await rm(base, { recursive: true, force: true });
});

describe('file_list — racine déclarée sous une autre forme que la racine résolue', () => {
  it('rend des noms relatifs à la racine, sans remonter l’arborescence', async () => {
    if (!lienUtilisable) {
      console.warn('[file-list-root-form] lien symbolique impossible — cas non vérifié ici');
      return;
    }

    const r = await fileListTool.execute(
      { recursive: true, glob: '**/*.md', path: 'ws' },
      ctxWith(parLien),
    );

    expect(r.ok, r.ok ? '' : JSON.stringify(r)).toBe(true);
    if (!r.ok) return;

    const noms = r.entries.map((e) => e.name).sort();
    // Le symptôme exact du défaut : un `..` dans un nom d'entrée. Il vaut la
    // peine d'être asserté à part, parce qu'il dit POURQUOI la comparaison
    // suivante échoue quand elle échoue.
    expect(
      noms.filter((n) => n.includes('..')),
      'des entrées sortent de la racine déclarée',
    ).toEqual([]);
    expect(noms).toEqual(['sub/nested.md', 'top.md']);
  });
});
