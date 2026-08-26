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

  it('renvoie explicitement le travail du propriétaire vers le dossier attaché', () => {
    const c = workspaceHygieneSkill.content;
    expect(c, 'rien ne dit à un agent avec son propre dossier que son livrable y va').toMatch(
      /workspace of your own/i,
    );
    expect(c).toMatch(/goes there/i);
  });

  it('ne prétend PAS trancher la question à la place du bloc de prompt', () => {
    // C'est le prompt qui sait si l'agent a un dossier attaché — lui le lit en
    // base. Le skill est un texte statique, il ne peut que renvoyer.
    expect(workspaceHygieneSkill.content).toContain('## Shared workspace');
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
