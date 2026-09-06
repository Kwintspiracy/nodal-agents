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
            { name: 'README.md', kind: 'file', bytes: 2048 },
          ],
          more: 5,
          ignored: 2,
          missing: false,
        }}
        proof={proofNonConfiguree}
        unconfigured={[
          {
            deliverableType: 'code_project',
            canonicalKey: 'd:/dev/nodal',
            displayPath: 'D:/Dev/nodal',
            reason: 'not_configured',
          },
        ]}
      />,
    );
    expect(html).toContain('apps/');
    expect(html).toContain('README.md');
    expect(html).toContain('2 KB');
    expect(html).toContain('2 ignored');
    // Le reste est COMPTÉ, jamais escamoté.
    expect(html).toContain('and 5 more, not read');
    expect(html).toContain('D:/Dev/nodal');
    // La preuve non configurée est dite, et l'écran de configuration nommé.
    expect(html).toContain('No command declared.');
    expect(html).toContain('Configure proof in Code');
  });

  it('un dossier disparu est DIT, pas dessiné comme un projet vide', () => {
    const html = renderToStaticMarkup(
      <ProjectShelf
        project={project}
        files={{ entries: [], more: 0, ignored: 0, missing: true }}
        proof={proofNonConfiguree}
        unconfigured={[]}
      />,
    );
    expect(html).toContain('This folder is not there any more.');
    expect(html).not.toContain('Nothing in here yet.');
  });

  it('la configuration de preuve approuvée est résumée en une ligne', () => {
    const html = renderToStaticMarkup(
      <ProjectShelf
        project={project}
        files={{ entries: [], more: 0, ignored: 0, missing: false }}
        proof={{
          configured: true,
          commands: [
            { command: 'pnpm test', timeoutSeconds: 600 },
            { command: 'pnpm lint', timeoutSeconds: 600 },
          ],
          approval: 'approved',
          sequences: [],
        }}
        unconfigured={[]}
      />,
    );
    expect(html).toContain('2 command');
    expect(html).toContain('approved');
    expect(html).not.toContain('No command declared.');
  });
});
