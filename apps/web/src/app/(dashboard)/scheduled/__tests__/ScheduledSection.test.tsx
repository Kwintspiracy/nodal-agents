// ScheduledSection.test.tsx — le corps de la page /scheduled rendu en HTML :
// une ligne par automatisation (son nom, son nombre de runs), et un run qui
// pointe vers son fil (`/spaces/<id>` — garde du plan « un run ouvre son
// fil »). Le titre « Scheduled » ne doit PLUS être dans le composant : il est
// le titre de la page.
//
// Rendu statique côté serveur (renderToStaticMarkup) : pas de navigateur, pas
// de bibliothèque de test de composants dans ce dépôt — on lit le HTML. Les
// groupes sont repliés par défaut, d'où le rendu séparé de `ScheduleRunList`
// (le composant que le parent déplie).

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ScheduledSection, { ScheduleRunList } from '../ScheduledSection.tsx';
import { groupSpaces } from '@/lib/spaces-list.ts';
import type { SpaceListRow } from '@/lib/actions.ts';

const run = (over: Partial<SpaceListRow> & { id: string }): SpaceListRow => ({
  agentName: 'Alfred',
  agentSlug: 'alfred',
  agentAvatarUrl: null,
  channel: 'cron',
  task: 'Goal: detect new CHANGELOG entries',
  status: 'completed',
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  createdAt: new Date('2026-09-06T08:00:00Z'),
  completedAt: null,
  conversationId: null,
  scheduleId: null,
  scheduleName: null,
  ...over,
});

// Deux automatisations, trois runs : deux pour « Changelog », un pour « Daily digest ».
const rows: SpaceListRow[] = [
  run({ id: 'job-1', scheduleId: 'sched-1', scheduleName: 'Changelog' }),
  run({ id: 'job-2', scheduleId: 'sched-2', scheduleName: 'Daily digest' }),
  run({ id: 'job-3', scheduleId: 'sched-1', scheduleName: 'Changelog', status: 'failed' }),
];

describe('ScheduledSection', () => {
  const { scheduled } = groupSpaces(rows);

  it('groupe les runs par automatisation et compte ce qui est listé', () => {
    expect(scheduled).toHaveLength(2);
    const html = renderToStaticMarkup(<ScheduledSection groups={scheduled} />);
    expect(html).toContain('Changelog');
    expect(html).toContain('Daily digest');
    expect(html).toContain('2 automations');
    expect(html).toContain('3 runs');
    expect(html).toContain('2 runs'); // le groupe « Changelog »
    expect(html).toContain('1 run'); // le groupe « Daily digest »
    expect(html).toContain('1 failed');
    // Le titre de section a disparu : la page porte le titre.
    expect(html).not.toContain('>Scheduled<');
  });

  it('un run déplié pointe vers son fil', () => {
    const changelog = scheduled.find((g) => g.name === 'Changelog');
    expect(changelog).toBeDefined();
    const html = renderToStaticMarkup(<ScheduleRunList runs={changelog!.runs} />);
    expect(html).toContain('href="/spaces/job-1"');
    expect(html).toContain('href="/spaces/job-3"');
    expect(html).not.toContain('href="/spaces/job-2"'); // l'autre automatisation
  });

  it('rien à montrer, rien à dessiner', () => {
    expect(renderToStaticMarkup(<ScheduledSection groups={[]} />)).toBe('');
  });
});
