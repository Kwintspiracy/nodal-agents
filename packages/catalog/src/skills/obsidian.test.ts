// obsidian.test.ts — la skill ne rend pas une note existante à la place du travail (#638).
//
// Son « Step 1 » disait : si une note du même sujet existe et paraît complète,
// « DO NOT RE-WRITE », réponds en citant ce fichier. C'est la règle que le banc
// `recipe` a prise en défaut sur le partagé : le livrable d'une demande passée
// servi comme réponse à une nouvelle. Une note existante n'est la réponse que
// si l'utilisateur la désigne. Ce qui reste juste — ne pas semer des
// `Note v2.md` à côté de l'original — est gardé.

import { describe, it, expect } from 'vitest';
import { obsidianSkill } from './obsidian';

describe('obsidian', () => {
  it('ne répond pas avec une note existante au lieu de faire la demande', () => {
    const c = obsidianSkill.content;
    expect(c).not.toMatch(/DO NOT RE-WRITE/);
    expect(c).not.toMatch(/referencing the existing file/i);
  });

  it('garde la discipline anti-doublon : la même note, pas une copie renommée', () => {
    const c = obsidianSkill.content;
    expect(c).toMatch(/on the SAME path/);
    expect(c).toMatch(/Writing a new file with a slightly different name/);
  });
});
