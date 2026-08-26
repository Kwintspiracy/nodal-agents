// workspace-hygiene.test.ts — le skill ne décide pas OÙ va le travail.
//
// Constat de Quentin (26/08), sur deux runs réels. Lead-Dev a fait construire
// une app par Dev C dans `shared/outputs/…` alors que les deux ont
// `Documents/Dev` attaché — la seconde fois APRÈS que le bloc
// `## Shared workspace` du prompt eut été corrigé pour dire l'inverse.
//
// La cause : ce skill est injecté à TOUS les agents en baseline, et sa section
// « One folder per kind » ne disait pas de quel workspace elle parlait. Elle se
// lisait « tout va dans le partagé, rangé par genre », et elle gagnait contre
// le prompt.
//
// Le skill garde son sujet — la discipline INTERNE du partagé — sans plus
// décider ce qui doit y atterrir.

import { describe, it, expect } from 'vitest';
import { workspaceHygieneSkill } from './workspace-hygiene';

describe('workspace-hygiene', () => {
  it('borne « one folder per kind » au workspace PARTAGÉ', () => {
    const c = workspaceHygieneSkill.content;
    const titre = c.split('\n').find((l) => l.includes('One folder per kind'));
    expect(titre, 'la section a disparu').toBeDefined();
    expect(
      titre!.toLowerCase(),
      'le titre ne dit pas de quel workspace il parle — il se lira « tout va dans le partagé »',
    ).toContain('shared workspace');
  });

  it('renvoie explicitement le travail vers le dossier propre de l’agent', () => {
    const c = workspaceHygieneSkill.content;
    expect(c, 'rien ne dit à un agent avec son propre dossier que son livrable y va').toMatch(
      /that folder is where your work goes/i,
    );
  });

  it('interdit nommément le `shared/` fabriqué à l’intérieur du dossier propre', () => {
    // LE symptôme du 26/08 : `C:\…\Documents\Dev\shared\outputs\todo-app-v2\`.
    // L'agent croyait n'avoir qu'un dossier, écrivait `shared/outputs/…`, et
    // collait les deux pour annoncer un chemin qui n'existait nulle part.
    // La cause est retirée (le partagé n'est plus injecté à ces agents) ; cette
    // phrase existe pour que l'habitude ne survive pas à la cause.
    expect(workspaceHygieneSkill.content).toMatch(/do not invent a .?shared\/.? path inside it/i);
  });

  it('dit à l’agent comment savoir s’il a un partagé', () => {
    // Le skill est un texte statique : il ne peut pas savoir. Il renvoie donc
    // aux deux blocs du prompt, qui eux le savent.
    const c = workspaceHygieneSkill.content;
    expect(c).toContain('## Shared workspace');
    expect(c).toContain('## Workspace');
  });

  it('n’installe pas le partagé comme LE lieu des fichiers produits', () => {
    // Constat du run 92e38e22 (26/08). Borner « One folder per kind » ne
    // suffisait pas : deux autres phrases cadraient encore le partagé comme la
    // destination par défaut de tout ce qu'un agent produit —
    //   * l'ouverture, « The shared workspace is a durable, common asset » ;
    //   * la section des bundles, « point its output argument at the shared
    //     workspace », d'où Lead-Dev a tiré `NODAL_SHARED_WORKSPACE`.
    // Elles sont vraies dans leur contexte, et se lisaient comme une consigne
    // générale.
    const c = workspaceHygieneSkill.content;
    const ouverture = c.slice(0, c.indexOf('### '));
    expect(
      ouverture,
      'l’ouverture ne dit pas que le skill parle du PARTAGÉ, pas de l’endroit où va ton travail',
    ).toMatch(/shared/i);
    expect(ouverture).toMatch(/## Shared workspace/);

    const bundles = c.slice(c.indexOf('### Skill bundles'));
    expect(
      bundles,
      'la section des bundles envoie encore les artefacts au partagé sans condition',
    ).toMatch(/your own if you have one/i);
  });

  it('garde sa discipline interne intacte', () => {
    // La correction devait BORNER la portée, pas vider le skill de son sujet.
    const c = workspaceHygieneSkill.content;
    for (const dossier of ['`workflows/`', '`outputs/`', '`scripts/`', '`documents/`']) {
      expect(c, `${dossier} a disparu de la disposition canonique`).toContain(dossier);
    }
    expect(c).toContain('Reuse before recreating');
  });
});
