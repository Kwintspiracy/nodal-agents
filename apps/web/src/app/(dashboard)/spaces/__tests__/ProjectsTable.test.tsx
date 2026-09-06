// ProjectsTable.test.tsx — le registre rendu en HTML : ce que la ligne d'un
// projet doit dire, et ce qu'elle ne doit pas taire (un projet masqué reste
// listé, un projet sans preuve ne s'affiche pas comme un échec).
//
// Rendu statique côté serveur (renderToStaticMarkup) : pas de navigateur, pas
// de bibliothèque de test de composants dans ce dépôt — on lit le HTML.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ProjectsTable from '../ProjectsTable.tsx';
import type { ProjectListRow } from '@/lib/project-actions.ts';

const projet = (over: Partial<ProjectListRow> & { id: string; name: string }): ProjectListRow => ({
  path: 'D:/Terrain/projet',
  kind: 'code',
  agentId: 'agent-1',
  agentName: 'Alfred',
  agentSlug: 'alfred',
  registeredFrom: 'spaces',
  registeredAt: new Date('2026-09-01T10:00:00Z'),
  hidden: false,
  jobsCount: 0,
  lastActivityAt: null,
  lastProof: null,
  ...over,
});

describe('ProjectsTable', () => {
  const rows: ProjectListRow[] = [
    projet({
      id: 'p-1',
      name: 'Nodal Agents',
      path: 'D:/Dev/nodal',
      jobsCount: 7,
      lastActivityAt: new Date(Date.now() - 60_000),
      lastProof: { verdict: 'fail', at: new Date(Date.now() - 60_000) },
    }),
    projet({
      id: 'p-2',
      name: 'Vieux dossier',
      path: 'D:/Dev/vieux',
      kind: 'documents',
      hidden: true,
    }),
  ];

  const html = renderToStaticMarkup(<ProjectsTable rows={rows} />);

  it('nomme chaque projet et pointe vers sa page', () => {
    expect(html).toContain('Nodal Agents');
    expect(html).toContain('Vieux dossier');
    expect(html).toContain('href="/spaces/p-1"');
    expect(html).toContain('href="/spaces/p-2"');
  });

  it('un projet masqué reste listé, et le DIT', () => {
    expect(html).toContain('hidden');
  });

  it('le verdict de la dernière preuve, et l’absence de preuve dite comme telle', () => {
    // Le projet prouvé rouge : une pastille d'alerte, jamais « Done ».
    expect(html).toContain('failed');
    expect(html).not.toContain('proved');
    // Le projet sans preuve : dit, pas peint en rouge.
    expect(html).toContain('no proof');
  });

  it('la sorte, le dossier et le compte de travaux', () => {
    expect(html).toContain('code');
    expect(html).toContain('documents');
    expect(html).toContain('D:/Dev/nodal');
    expect(html).toContain('>7<');
    // Un projet sans activité : « never », pas une case vide.
    expect(html).toContain('never');
  });
});
