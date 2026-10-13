// obsidian.test.ts — la skill ne dit aucune règle de reprise de fichier (#638).
//
// Son « Step 1 » disait : si une note du même sujet existe et paraît complète,
// « DO NOT RE-WRITE », réponds en citant ce fichier. C'est la règle que le banc
// `recipe` a prise en défaut sur le partagé : le livrable d'une demande passée
// servi comme réponse à une nouvelle.
//
// Deux corrections successives ont ensuite RE-LÉGIFÉRÉ la reprise dans la
// skill (revue de #640, passes 1 et 2) : d'abord « écris au même chemin » (la
// note de l'utilisateur écrasée), puis « termine une tentative précédente de
// CETTE tâche » — sans critère observable, puisque la skill dit elle-même que
// l'agent n'a aucune mémoire de ces tentatives. Deux énoncés de la même règle,
// qui s'opposaient.
//
// La règle vit UNE fois, dans le bloc `## Shared workspace` du prompt, avec son
// seul critère observable (un fichier que TU as écrit pendant CE job). La
// skill garde ce qui lui est propre : chemins, syntaxe, emplacement des notes,
// et un nom distinct quand celui qu'on a choisi est déjà pris.

import { describe, it, expect } from 'vitest';
import { obsidianSkill } from './obsidian';

const c = obsidianSkill.content;

/**
 * Même détecteur que `system-prompt.test.ts` (#638) : une phrase qui porte un
 * verbe de reprise ou d'adaptation ET un mot qui désigne ce qui est déjà là,
 * ou l'une des formes historiques de la règle.
 */
function phrasesDeReprise(texte: string): string[] {
  const verbe =
    /\b(reus(e|ing)|re-use|updat(e|ing)|adapt(ing)?|rework(ing)?|extend(ing)?|enrich(ing)?|rebuild(ing)?|recreat(e|ing))\b|\bload\b[^.]*\badapt/i;
  const existant = /\b(existing|already|listed)\b/i;
  const historique = /do not re-?write|referencing the existing file|already answers the task/i;
  return texte
    .split('\n')
    .flatMap((p) => p.split(/(?<=[.:!?])\s+/))
    .filter((phrase) => (verbe.test(phrase) && existant.test(phrase)) || historique.test(phrase));
}

describe('obsidian', () => {
  it('ne rend pas une note existante à la place du travail demandé', () => {
    expect(c).not.toMatch(/DO NOT RE-WRITE/);
    expect(c).not.toMatch(/referencing the existing file/i);
  });

  it('ne redit aucune règle de reprise — ni tentative précédente, ni brouillon', () => {
    expect(phrasesDeReprise(c)).toEqual([]);
    expect(c, 'une « tentative précédente » sans critère observable').not.toMatch(
      /previous (attempt|call)/i,
    );
    expect(c, 'tout fichier lu comme un brouillon à reprendre').not.toMatch(/draft/i);
    expect(c, 'la moitié « livrable » du prompt, redite').not.toMatch(/names it or asks/i);
    expect(c, 'un Step 1 qui gouverne la reprise').not.toMatch(/STEP 1|Step 1/);
    // L'anti-pattern « Note v2.md » ne disait plus que la règle du prompt.
    expect(c).not.toMatch(/Note v2\.md/);
  });

  it('garde ce qui lui est propre, dont un nom distinct quand le nom est pris', () => {
    expect(c).toMatch(/### Create a note/);
    expect(c).toMatch(/\*\*relative\*\* to the vault root/);
    expect(c).toMatch(
      /already taken by a note you did not write in this job[^\n]*distinct, descriptive name/i,
    );
  });

  it('écrit au nom que l’utilisateur a donné, même s’il est pris (revue de #640, passe 3)', () => {
    // « Écris-la dans Recipes/Pain.md » : sans l'exception, la skill ferait un
    // `Recipes/Pain (2).md` à côté. C'est la même condition que le prompt : un
    // fichier que l'utilisateur désigne est la cible.
    const ligne = c.split('\n').find((l) => l.includes('already taken by a note')) ?? '';
    expect(ligne).toMatch(/the user did not name that file/i);
  });
});
