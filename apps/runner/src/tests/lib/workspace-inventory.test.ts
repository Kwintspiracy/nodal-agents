// workspace-inventory.test.ts — real-filesystem tests for the shared-workspace
// inventory injected into the system prompt (lib/workspace-inventory.ts).
// Assertions target the RENDERED text (what the LLM actually reads), not call
// counts (invariant 5).

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SHARED_WORKSPACE_FOLDERS } from '@nodal-agents/catalog';

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

  it('names the files of a MEANS folder, counts the others; root files are counted', async () => {
    // #638 : les NOMS des livrables d'hier ne sont plus dans la liste — le
    // banc `recipe` a vu `caviar-aubergines.html` et le root l'a rouvert au
    // lieu de faire la demande. Les MOYENS, eux, restent nommés : « réutilise
    // le gabarit Krea 2 Turbo » doit trouver `Krea2_Turbo_NSFW.json` sans
    // fouiller (revue de #658, passe 1).
    await mkdir(join(root, 'workflows'));
    await writeFile(join(root, 'workflows', 'sauna.json'), '{}');
    await writeFile(join(root, 'workflows', 'zimage.json'), '{}');
    await mkdir(join(root, 'outputs', 'v3'), { recursive: true });
    await writeFile(join(root, 'outputs', 'v3', 'img.png'), 'x');
    await writeFile(join(root, 'note.md'), 'hello');
    await writeFile(join(root, 'budget.xlsx'), 'x');

    const text = await buildSharedWorkspaceInventory(root);

    expect(text).toBe(
      [
        '- outputs/ (1 file)',
        '- workflows/ (2 files): sauna.json, zimage.json',
        '- 2 files at the root',
      ].join('\n'),
    );
    for (const name of ['v3', 'img.png', 'note.md', 'budget.xlsx']) {
      expect(text, `le nom « ${name} » est listé`).not.toContain(name);
    }
  });

  it('reconstitue le cas caviar du 01/10 : le livrable d’hier n’est plus nommé, le gabarit l’est', async () => {
    // L'espace partagé réel du job a22e173f (01/10), en modèle réduit : un
    // dossier au nom du plat, ses trois fichiers, et les dossiers de moyens.
    await mkdir(join(root, 'caviar-aubergines'));
    for (const f of ['caviar-aubergines.html', 'caviar-aubergines.pdf', 'photo.jpg']) {
      await writeFile(join(root, 'caviar-aubergines', f), 'x');
    }
    await mkdir(join(root, 'documents'));
    await writeFile(join(root, 'documents', 'cicada3301_report.html'), 'x');
    await mkdir(join(root, 'scripts'));
    await writeFile(join(root, 'scripts', '_gen_redhead.py'), 'x');
    await mkdir(join(root, 'workflows'));
    await writeFile(join(root, 'workflows', 'Krea2_Turbo_NSFW.json'), '{}');
    await writeFile(join(root, 'budget-septembre.xlsx'), 'x');

    const text = await buildSharedWorkspaceInventory(root);

    expect(text).toBe(
      [
        '- caviar-aubergines/ (3 files)',
        '- documents/ (1 file)',
        '- scripts/ (1 file): _gen_redhead.py',
        '- workflows/ (1 file): Krea2_Turbo_NSFW.json',
        '- 1 file at the root',
      ].join('\n'),
    );
    for (const name of [
      'caviar-aubergines.html',
      'caviar-aubergines.pdf',
      'photo.jpg',
      'cicada3301_report.html',
      'budget-septembre.xlsx',
    ]) {
      expect(text, `le livrable « ${name} » est nommé`).not.toContain(name);
    }
  });

  it('les dossiers de moyens sont ceux du catalogue (workspace-hygiene), et seulement eux', async () => {
    // UNE source : la liste que la skill workspace-hygiene annonce aux agents
    // est celle que l'inventaire lit. Un dossier ajouté au catalogue comme
    // moyen devient nommé ici sans toucher au runner.
    expect(SHARED_WORKSPACE_FOLDERS.some((f) => f.holds === 'means')).toBe(true);
    expect(SHARED_WORKSPACE_FOLDERS.some((f) => f.holds === 'deliverables')).toBe(true);
    for (const f of SHARED_WORKSPACE_FOLDERS) {
      await mkdir(join(root, f.name));
      await writeFile(join(root, f.name, `inside-${f.name}.txt`), 'x');
    }

    const text = (await buildSharedWorkspaceInventory(root))!;

    for (const f of SHARED_WORKSPACE_FOLDERS) {
      if (f.holds === 'means') {
        expect(text, f.name).toContain(`- ${f.name}/ (1 file): inside-${f.name}.txt`);
      } else {
        expect(text, f.name).toContain(`- ${f.name}/ (1 file)`);
        expect(text, f.name).not.toContain(`inside-${f.name}.txt`);
      }
    }
  });

  it('caps the names of a means folder with an ellipsis', async () => {
    await mkdir(join(root, 'scripts'));
    for (let i = 0; i < 25; i++) {
      await writeFile(join(root, 'scripts', `s${String(i).padStart(2, '0')}.py`), 'x');
    }

    const text = await buildSharedWorkspaceInventory(root);

    expect(text).toContain('- scripts/ (25 files): s00.py');
    expect(text).toContain('s19.py, …');
    expect(text).not.toContain('s20.py');
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
