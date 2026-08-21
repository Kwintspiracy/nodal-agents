// skill-write-paths.test.ts — SKILL-002.
//
// Le lint du contenu de skill n'était appliqué que par les OUTILS create_skill /
// update_skill. La boucle de réflexion et le curateur écrivaient via
// createSkillRepo / updateSkillRepo en direct et le sautaient — or c'est le seul
// écrivain dont le contenu est rédigé par un modèle SANS humain dans la boucle.
//
// Ce test est structurel : il vérifie qu'aucun appelant de createSkillRepo /
// updateSkillRepo n'écrit sans avoir linté. Un test de comportement ne
// l'attraperait pas, parce que le contournement est invisible tant que le
// modèle n'écrit rien d'hostile.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function tsFilesUnder(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) {
      if (!['node_modules', 'dist', '.next'].includes(e)) tsFilesUnder(full, acc);
    } else if (e.endsWith('.ts') && !e.endsWith('.test.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

describe('SKILL-002 — tout écrivain de skill passe par le linter', () => {
  it('aucun fichier n’appelle createSkillRepo/updateSkillRepo sans lintSkillContent', () => {
    const roots = [
      join(REPO_ROOT, 'apps', 'runner', 'src'),
      join(REPO_ROOT, 'packages', 'tools', 'src'),
    ];

    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of tsFilesUnder(root)) {
        const src = readFileSync(file, 'utf-8');
        const writes = /\b(createSkillRepo|updateSkillRepo)\s*\(/.test(src);
        if (!writes) continue;
        // Le repo lui-même (packages/db) n'est pas dans le périmètre ; ici on
        // ne regarde que les APPELANTS.
        if (!src.includes('lintSkillContent')) {
          offenders.push(file.replace(REPO_ROOT, '').split('\\').join('/'));
        }
      }
    }

    expect(
      offenders,
      `Ces fichiers écrivent une skill sans linter son contenu :\n  ${offenders.join('\n  ')}\n` +
        'Importez lintSkillContent depuis @nodal-agents/tools et appelez-le AVANT l’écriture.',
    ).toEqual([]);
  });

  it('CONTRE-ÉPREUVE : le scanner détecte bien un contournement', () => {
    // Sans ceci, un scanner cassé (mauvais regex, mauvais chemin) rendrait le
    // test ci-dessus vert pour toujours.
    const fake = 'const res = await createSkillRepo(db, entityId, {});';
    expect(/\b(createSkillRepo|updateSkillRepo)\s*\(/.test(fake)).toBe(true);
    expect(fake.includes('lintSkillContent')).toBe(false);
  });
});
