// workspace-inventory.test.ts — real-filesystem tests for the shared-workspace
// inventory injected into the system prompt (lib/workspace-inventory.ts).
// Assertions target the RENDERED text (what the LLM actually reads), not call
// counts (invariant 5).

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildSharedWorkspaceInventory } from '../../lib/workspace-inventory.ts';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nodal-inv-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('buildSharedWorkspaceInventory', () => {
  it('un dossier VIDE rend "", un dossier ILLISIBLE rend null — jamais la même chose', async () => {
    // Constat Codex (27/08). Les deux se rendaient `''`, donc « (empty) » dans
    // le prompt : l'agent lisait « il n'y a rien » là où la vérité était « on
    // n'a pas su regarder », et recréait en confiance ce qu'il n'avait pas vu.
    expect(await buildSharedWorkspaceInventory(root), 'un dossier vide est vide').toBe('');
    expect(
      await buildSharedWorkspaceInventory(join(root, 'nope')),
      'un dossier qu’on ne peut pas lire se déguise en dossier vide',
    ).toBeNull();
  });

  it('lists folders first with their recursive file count, never the names inside; root files are counted', async () => {
    // #638 : les NOMS de fichiers sont des livrables d'hier. Le banc `recipe`
    // a vu `caviar-aubergines.html` dans cette liste et le root l'a rouvert au
    // lieu de faire la demande du jour. Le dossier et son compte disent où
    // ranger et qu'il y a quelque chose ; le contenu se lit à la demande.
    await mkdir(join(root, 'workflows'));
    await writeFile(join(root, 'workflows', 'sauna.json'), '{}');
    await writeFile(join(root, 'workflows', 'zimage.json'), '{}');
    await mkdir(join(root, 'outputs', 'v3'), { recursive: true });
    await writeFile(join(root, 'outputs', 'v3', 'img.png'), 'x');
    await writeFile(join(root, 'note.md'), 'hello');
    await writeFile(join(root, 'budget.xlsx'), 'x');

    const text = await buildSharedWorkspaceInventory(root);

    expect(text).toBe(
      ['- outputs/ (1 file)', '- workflows/ (2 files)', '- 2 files at the root'].join('\n'),
    );
    for (const name of ['sauna.json', 'zimage.json', 'v3', 'img.png', 'note.md', 'budget.xlsx']) {
      expect(text, `le nom « ${name} » est listé`).not.toContain(name);
    }
  });

  it('reconstitue le cas caviar du 01/10 : le livrable d’hier n’est plus nommé', async () => {
    // L'espace partagé réel du job a22e173f (01/10), en modèle réduit : un
    // dossier au nom du plat, ses trois fichiers, et les dossiers de moyens.
    await mkdir(join(root, 'caviar-aubergines'));
    for (const f of ['caviar-aubergines.html', 'caviar-aubergines.pdf', 'photo.jpg']) {
      await writeFile(join(root, 'caviar-aubergines', f), 'x');
    }
    await mkdir(join(root, 'scripts'));
    await writeFile(join(root, 'scripts', '_gen_redhead.py'), 'x');
    await mkdir(join(root, 'workflows'));
    await writeFile(join(root, 'budget-septembre.xlsx'), 'x');

    const text = await buildSharedWorkspaceInventory(root);

    expect(text).toBe(
      [
        '- caviar-aubergines/ (3 files)',
        '- scripts/ (1 file)',
        '- workflows/ (0 files)',
        '- 1 file at the root',
      ].join('\n'),
    );
    for (const name of [
      'caviar-aubergines.html',
      'caviar-aubergines.pdf',
      'photo.jpg',
      '_gen_redhead.py',
      'budget-septembre.xlsx',
    ]) {
      expect(text, `le nom « ${name} » est listé`).not.toContain(name);
    }
  });

  it('ignores node_modules and dot-entries entirely', async () => {
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'x');
    await mkdir(join(root, '.shot'));
    await writeFile(join(root, '.hidden'), 'x');
    await writeFile(join(root, 'real.txt'), 'x');

    const text = await buildSharedWorkspaceInventory(root);

    expect(text).toBe('- 1 file at the root');
  });

  it('elides folders beyond the cap instead of growing unbounded; root files stay one line', async () => {
    for (let i = 0; i < 35; i++) {
      await mkdir(join(root, `dir-${String(i).padStart(2, '0')}`));
    }
    for (let i = 0; i < 40; i++) {
      await writeFile(join(root, `file-${String(i).padStart(2, '0')}.txt`), 'x');
    }

    const text = await buildSharedWorkspaceInventory(root);

    expect(text).toContain('- dir-00/ (0 files)');
    expect(text).not.toContain('dir-30/');
    expect(text).toContain('- … 5 more folders elided');
    expect(text).toContain('- 40 files at the root');
    // 30 folders + 1 elision line + 1 root-files line.
    expect(text!.split('\n')).toHaveLength(32);
  });
});
