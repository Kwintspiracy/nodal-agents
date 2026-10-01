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

  it('dit à l’agent comment savoir s’il a un partagé — par la LISTE, pas par l’inventaire', () => {
    // Le skill est un texte statique : il ne peut pas savoir. Il renvoie donc
    // aux blocs du prompt, qui eux le savent.
    //
    // Il renvoyait à l'INVENTAIRE (« si tu n'as pas de bloc `## Shared
    // workspace`, tu n'en as pas »), et c'était faux pour tout agent en runtime
    // CLI : ces chemins montent bien le partagé dans `## Workspaces` mais ne
    // construisent jamais l'inventaire. On leur affirmait donc que le dossier
    // de transmission de l'équipe n'existe pas alors qu'il est là et
    // accessible en écriture (revue Codex, 27/08).
    //
    // La liste des dossiers est ce que les OUTILS peuvent atteindre : c'est
    // elle qui fait foi. L'inventaire ne dit que ce qu'il y a dedans.
    const c = workspaceHygieneSkill.content;
    const consigne = c.slice(0, c.indexOf('One folder per kind'));
    expect(consigne, 'la présence du partagé se déduit du bloc Workspaces').toContain(
      '`## Workspaces` block lists a folder labelled `shared`',
    );
    // Et l'absence d'inventaire ne vaut PLUS absence de dossier.
    expect(consigne).toContain('never that the folder is missing');
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
    // Depuis le régime du 01/10/2026, l'ouverture est le paragraphe avant la
    // liste des règles.
    const ouverture = c.slice(0, c.indexOf('\n- '));
    expect(
      ouverture,
      'l’ouverture ne dit pas que le skill parle du PARTAGÉ, pas de l’endroit où va ton travail',
    ).toMatch(/shared/i);
    expect(ouverture).toMatch(/## Shared workspace/);

    const bundles = c.slice(c.indexOf("into a skill's folder"));
    expect(
      bundles,
      'la section des bundles envoie encore les artefacts au partagé sans condition',
    ).toMatch(/your own (folder )?if you have one/i);
  });

  it('garde sa discipline interne intacte', () => {
    // La correction devait BORNER la portée, pas vider le skill de son sujet.
    const c = workspaceHygieneSkill.content;
    for (const dossier of ['`workflows/`', '`outputs/`', '`scripts/`', '`documents/`']) {
      expect(c, `${dossier} a disparu de la disposition canonique`).toContain(dossier);
    }
  });

  it('ne dit pas la règle de reprise — le bloc `## Shared workspace` la dit, une fois (#638)', () => {
    // La section « Reuse before recreating » ordonnait de reprendre « a
    // workflow, script, or document » déjà présent. Le mot « document »
    // l'étendait aux livrables d'une demande passée : le banc `recipe` a vu le
    // root reprendre la recette PDF d'un run précédent au lieu de faire la
    // demande. La règle, corrigée (les moyens, pas les livrables), vit à côté
    // de l'inventaire qu'elle gouverne ; la répéter ici, c'était deux textes à
    // tenir d'accord, et c'est la version fausse qui avait survécu.
    const c = workspaceHygieneSkill.content;
    expect(c).not.toMatch(/### Reuse/);
    expect(c).not.toMatch(/\breuse\b/i);
    expect(workspaceHygieneSkill.description).not.toMatch(/\breuse\b/i);
  });
});
