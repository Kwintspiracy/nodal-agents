// ProjectGitPanel.test.tsx — l'interrupteur git d'un projet, et ce qu'il DIT
// (issue #200).
//
// Deux choses se prouvent ici, et elles ne sont pas décoratives. Que
// l'interrupteur est ÉTEINT tant que personne ne l'a allumé : poser un dépôt
// écrit dans le dossier de quelqu'un, et un interrupteur allumé d'office
// invite à cliquer sans savoir. Et qu'il est REFUSÉ hors propriétaire, dit
// plutôt que simplement inerte — un bouton mort sans phrase est un bug pour
// qui le regarde.
//
// Rendu statique côté serveur : on lit le HTML.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ProjectGitPanel, { type ProjectGit } from '../ProjectGitPanel.tsx';

const RIEN: ProjectGit = { initGit: false, gitInitializedAt: null };

function rendu(git: ProjectGit, isOwner = true): string {
  return renderToStaticMarkup(
    <ProjectGitPanel
      projectId="11111111-1111-4111-8111-111111111111"
      git={git}
      isOwner={isOwner}
    />,
  );
}

describe('ProjectGitPanel — l’option git @cap:travailler-sur-des-fichiers/ecran', () => {
  it('l’interrupteur est ÉTEINT tant que personne ne l’a allumé', () => {
    const html = rendu(RIEN);

    expect(html).toContain('Initialise git in this folder');
    expect(html).toContain('aria-checked="false"');
    // Rien n'a été posé : aucune date, et surtout aucune phrase qui le
    // laisserait croire.
    expect(html).not.toContain('Nodal initialised this repository');
  });

  it('dit ce que l’option apporte, et ce qu’elle ne fait pas', () => {
    const html = rendu(RIEN);

    expect(html).toContain('lists exactly the files each run wrote');
    // Ce que personne ne doit découvrir après coup : Nodal ne commite pas et
    // ne pousse pas.
    expect(html).toContain('Nothing is committed and nothing is pushed');
  });

  it('une fois le dépôt posé, l’écran dit QUAND — le fait, pas l’intention', () => {
    const html = rendu({ initGit: true, gitInitializedAt: new Date(Date.now() - 3_600_000) });

    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('Nodal initialised this repository');
  });

  it('option ON sur un dossier qui était DÉJÀ un dépôt : aucune date inventée', () => {
    // L'intention est vraie, le fait n'a pas eu lieu — Nodal n'a rien posé.
    // Lui donner une date de pose serait un mensonge de plus dans un écran qui
    // existe pour dire ce qui s'est réellement passé.
    const html = rendu({ initGit: true, gitInitializedAt: null });

    expect(html).toContain('aria-checked="true"');
    expect(html).not.toContain('Nodal initialised this repository');
  });

  it('hors propriétaire : l’interrupteur est désactivé ET la raison est écrite', () => {
    const html = rendu(RIEN, false);

    expect(html).toContain('owner only');
    expect(html).toContain('Only the workspace owner can initialise git');
    expect(html).toContain('disabled=""');
  });
});
