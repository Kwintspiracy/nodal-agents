// ProjectConversations.test.tsx — les conversations d'un projet rendues en
// HTML : chacune renvoie à son fil, et l'ANCRAGE se voit.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ProjectConversations from '../ProjectConversations.tsx';
import type { ProjectConversationRow } from '@/lib/project-actions.ts';

const rows: ProjectConversationRow[] = [
  {
    id: 'c-1',
    channel: 'dashboard',
    title: 'Refonte de la page projet',
    agentName: 'Alfred',
    agentSlug: 'alfred',
    updatedAt: new Date('2026-09-05T10:00:00Z'),
    anchored: true,
  },
  {
    id: 'c-2',
    channel: 'telegram',
    title: '',
    agentName: 'Alfred',
    agentSlug: 'alfred',
    updatedAt: new Date('2026-09-04T10:00:00Z'),
    anchored: false,
  },
];

describe('ProjectConversations', () => {
  const html = renderToStaticMarkup(<ProjectConversations rows={rows} />);

  it('chaque conversation renvoie à son fil', () => {
    expect(html).toContain('href="/chat/c-1"');
    expect(html).toContain('href="/chat/c-2"');
    expect(html).toContain('Refonte de la page projet');
    // Sans titre, on le dit — jamais un identifiant à l'écran.
    expect(html).toContain('Untitled');
  });

  it('l’ancrage se voit, et seulement là où il existe', () => {
    expect(html).toContain('anchored');
    // Une seule pilule : celle de la conversation ancrée.
    expect(html.match(/anchored/g)).toHaveLength(1);
  });

  it('l’origine de chaque conversation est nommée', () => {
    expect(html).toContain('from the dashboard');
    expect(html).toContain('via Telegram');
  });
});
