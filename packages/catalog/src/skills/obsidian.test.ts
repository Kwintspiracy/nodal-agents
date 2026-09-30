// obsidian.test.ts — la skill ne rend pas une note existante à la place du travail (#638).
//
// Son « Step 1 » disait : si une note du même sujet existe et paraît complète,
// « DO NOT RE-WRITE », réponds en citant ce fichier. C'est la règle que le banc
// `recipe` a prise en défaut sur le partagé : le livrable d'une demande passée
// servi comme réponse à une nouvelle.
//
// La première correction (« écris ton travail au MÊME chemin ») tombait dans
// l'excès inverse (revue de #640, passe 1) : la note « Trous noirs.md » que
// l'utilisateur a écrite lui-même était réécrite dès qu'on lui demandait une
// note sur l'article X du même sujet. La skill tient donc la même condition que
// le prompt : une note existante n'est modifiée que si l'utilisateur la désigne
// ou demande de la reprendre. Seule une tentative précédente de CE travail se
// termine au même chemin — c'est l'anti-doublon d'origine.

import { describe, it, expect } from 'vitest';
import { obsidianSkill } from './obsidian';

const c = obsidianSkill.content;
const step1 = c.slice(c.indexOf('### ⚠️ STEP 1'), c.indexOf('### ⚠️ Research'));

describe('obsidian', () => {
  it('ne répond pas avec une note existante au lieu de faire la demande', () => {
    expect(c).not.toMatch(/DO NOT RE-WRITE/);
    expect(c).not.toMatch(/referencing the existing file/i);
    expect(step1, 'le travail demandé n’est plus prescrit').toMatch(
      /do the work this task asks for/i,
    );
  });

  it('ne touche une note existante que si l’utilisateur la désigne', () => {
    expect(step1).toMatch(
      /change an existing note only when the user names it or asks you to rework it/i,
    );
    // Sinon, le livrable est une note NOUVELLE, nommée pour ce qu'elle est.
    expect(step1).toMatch(/write a new note with a distinct, descriptive name/i);
  });

  it('garde la discipline anti-doublon, pour une tentative précédente de CE travail', () => {
    expect(step1).toMatch(/previous attempt at this task[^\n]*on the SAME path/i);
    expect(c).toMatch(/Writing a new file with a slightly different name/);
  });

  it('chaque étape de la liste est sur sa ligne', () => {
    // La première correction avait collé « 3. Otherwise » à la fin de l'étape 2.
    expect(step1).toMatch(/\n3\. Otherwise/);
    expect(step1).not.toMatch(/\S3\. Otherwise/);
  });
});
