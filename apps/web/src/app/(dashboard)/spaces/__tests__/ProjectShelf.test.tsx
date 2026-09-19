// ProjectShelf.test.tsx — l'étagère rendue en HTML : ce qu'il y a dans le
// dossier, et ce qu'on dit quand le dossier n'y est plus.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ProjectShelf from '../ProjectShelf.tsx';
import type { ProjectPageView } from '@/lib/project-actions.ts';

const project: ProjectPageView['project'] = {
  id: 'p-1',
  name: 'Nodal Agents',
  path: 'D:/Dev/nodal',
  kind: 'code',
  agentId: 'agent-1',
  agentName: 'Alfred',
  agentSlug: 'alfred',
  hidden: false,
  registeredFrom: 'spaces',
  registeredAt: new Date('2026-09-01T10:00:00Z'),
  initGit: false,
  gitInitializedAt: null,
  jobsCount: 3,
  lastActivityAt: new Date('2026-09-05T10:00:00Z'),
};

const proofNonConfiguree: ProjectPageView['proof'] = {
  configured: false,
  commands: null,
  approval: 'not_configured',
  sequences: [],
};

describe('ProjectShelf', () => {
  it('montre les entrées du dossier, leurs tailles, et ce qui a été ignoré', () => {
    const html = renderToStaticMarkup(
      <ProjectShelf
        project={project}
        files={{
          entries: [
            { name: 'apps', kind: 'dir', bytes: null },
            { name: 'vendor', kind: 'symlink', bytes: null },
            { name: 'README.md', kind: 'file', bytes: 2048 },
          ],
          more: 5,
          ignored: 2,
          unreadable: null,
        }}
        proof={proofNonConfiguree}
      />,
    );
    expect(html).toContain('apps/');
    expect(html).toContain('README.md');
    // Un lien porte sa flèche : il ne passe pas pour un fichier du projet.
    expect(html).toContain('vendor →');
    expect(html).toContain('2 KB');
    expect(html).toContain('2 ignored');
    // Le reste est COMPTÉ, jamais escamoté.
    expect(html).toContain('and 5 more, not read');
    expect(html).toContain('D:/Dev/nodal');
    // La preuve non configurée est DITE. Plus de renvoi vers l'écran Code
    // (#143) : le panneau qui écrit ces commandes est sur la même page, juste
    // en dessous, et un lien ferait quitter l'écran pour y revenir.
    expect(html).toContain('No command declared.');
    expect(html).not.toContain('Configure proof in Code');
    expect(html).not.toContain('href="/code"');
  });

  it('un dossier disparu est DIT, pas dessiné comme un projet vide', () => {
    const html = renderToStaticMarkup(
      <ProjectShelf
        project={project}
        files={{ entries: [], more: 0, ignored: 0, unreadable: 'absent' }}
        proof={proofNonConfiguree}
      />,
    );
    expect(html).toContain('This folder is not there any more.');
    expect(html).not.toContain('Nothing in here yet.');
  });

  it('chaque CAUSE d’illisibilité a sa phrase — jamais « supprimé » par défaut', () => {
    const dire = (unreadable: 'not_a_directory' | 'permission' | 'error') =>
      renderToStaticMarkup(
        <ProjectShelf
          project={project}
          files={{ entries: [], more: 0, ignored: 0, unreadable }}
          proof={proofNonConfiguree}
        />,
      );
    expect(dire('not_a_directory')).toContain('This path is not a folder.');
    expect(dire('permission')).toContain('This folder cannot be read (permission).');
    expect(dire('error')).toContain('This folder cannot be read.');
    // Aucune ne dit la suppression : ce serait envoyer chercher un dossier qui
    // est toujours là.
    for (const cause of ['not_a_directory', 'permission', 'error'] as const) {
      expect(dire(cause)).not.toContain('not there any more');
    }
  });

  it('un chemin LONG est coupé par le CSS, et garde sa valeur entière', () => {
    // Dans un panneau de 400 px, un chemin de projet dépassait par la droite
    // (Quentin, 19/09). jsdom ne calcule aucune largeur : ce qui se vérifie
    // ici est le CONTRAT qui l'empêche — la colonne qui peut rétrécir, la
    // coupe CSS, et la valeur entière conservée pour la copie et l'infobulle.
    // La mesure réelle, elle, se fait au navigateur (parcours G de
    // `code-verification.spec.ts`).
    const long =
      'D:/APPS/NodalAI/apps/web/src/app/(dashboard)/spaces/un-dossier-au-nom-interminable';
    const html = renderToStaticMarkup(
      <ProjectShelf
        project={{ ...project, path: long }}
        files={{ entries: [], more: 0, ignored: 0, unreadable: null }}
        proof={proofNonConfiguree}
      />,
    );
    expect(html).toContain('truncate');
    expect(html).toContain('min-w-0');
    // La valeur entière survit : c'est elle qu'on copie et qu'on survole.
    expect(html).toContain(long);
  });

  it('la ligne de preuve se coupe elle aussi, et dit le DERNIER verdict', () => {
    const html = renderToStaticMarkup(
      <ProjectShelf
        project={project}
        files={{ entries: [], more: 0, ignored: 0, unreadable: null }}
        proof={{
          configured: true,
          commands: [{ command: 'pnpm test', timeoutSeconds: 600 }],
          approval: 'approved',
          sequences: [
            {
              sequenceId: 's1',
              jobId: null,
              deliverableType: 'code_project',
              canonicalKey: 'd:/dev/nodal',
              verdict: 'red',
              startedAt: '2026-09-18T10:00:00.000Z',
              runs: [],
            },
            {
              sequenceId: 's2',
              jobId: null,
              deliverableType: 'code_project',
              canonicalKey: 'd:/dev/nodal',
              verdict: 'green',
              startedAt: '2026-09-19T10:00:00.000Z',
              runs: [],
            },
          ],
        }}
      />,
    );
    // Le DERNIER verdict, pas le premier : le rouge de la veille ne décrit
    // plus rien.
    expect(html).toContain('green');
    expect(html).not.toContain('failed');
    expect(html).toContain('2 runs');
    expect(html).toContain('1 command ');
    expect(html).toContain('approved');
    // UNE section, plus trois couches : le bloc replié « VERIFICATION » a
    // disparu avec elles (Quentin, 19/09).
    expect(html).not.toContain('VERIFICATION');
  });

  it('la configuration de preuve approuvée est résumée en une ligne', () => {
    const html = renderToStaticMarkup(
      <ProjectShelf
        project={project}
        files={{ entries: [], more: 0, ignored: 0, unreadable: null }}
        proof={{
          configured: true,
          commands: [
            { command: 'pnpm test', timeoutSeconds: 600 },
            { command: 'pnpm lint', timeoutSeconds: 600 },
          ],
          approval: 'approved',
          sequences: [],
        }}
      />,
    );
    expect(html).toContain('2 command');
    expect(html).toContain('approved');
    expect(html).not.toContain('No command declared.');
  });
});
