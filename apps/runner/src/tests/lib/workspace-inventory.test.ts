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

  it('lists directories first with recursive file counts and child names, then root files', async () => {
    await mkdir(join(root, 'workflows'));
    await writeFile(join(root, 'workflows', 'sauna.json'), '{}');
    await writeFile(join(root, 'workflows', 'zimage.json'), '{}');
    await mkdir(join(root, 'outputs', 'v3'), { recursive: true });
    await writeFile(join(root, 'outputs', 'v3', 'img.png'), 'x');
    await writeFile(join(root, 'note.md'), 'hello');

    const text = await buildSharedWorkspaceInventory(root);

    // Recursive count includes nested files; children show the first level.
    expect(text).toContain('- workflows/ (2 files): sauna.json, zimage.json');
    expect(text).toContain('- outputs/ (1 file): v3/');
    expect(text).toContain('- note.md');
    // Directories listed before files.
    expect(text!.indexOf('workflows/')).toBeLessThan(text!.indexOf('note.md'));
  });

  it('ignores node_modules and dot-entries entirely', async () => {
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'x');
    await mkdir(join(root, '.shot'));
    await writeFile(join(root, '.hidden'), 'x');
    await writeFile(join(root, 'real.txt'), 'x');

    const text = await buildSharedWorkspaceInventory(root);

    expect(text).toBe('- real.txt');
  });

  it('elides root entries beyond the cap instead of growing unbounded', async () => {
    for (let i = 0; i < 35; i++) {
      await writeFile(join(root, `file-${String(i).padStart(2, '0')}.txt`), 'x');
    }

    const text = await buildSharedWorkspaceInventory(root);

    expect(text).toContain('- file-00.txt');
    expect(text).toContain('5 more root entries elided');
    // 30 shown + 1 elision line.
    expect(text!.split('\n')).toHaveLength(31);
  });

  it('caps child names per directory with an ellipsis', async () => {
    await mkdir(join(root, 'big'));
    for (let i = 0; i < 12; i++) {
      await writeFile(join(root, 'big', `f${String(i).padStart(2, '0')}.txt`), 'x');
    }

    const text = await buildSharedWorkspaceInventory(root);

    expect(text).toContain('- big/ (12 files): f00.txt');
    expect(text).toContain('f07.txt, …');
    expect(text).not.toContain('f08.txt');
  });
});
