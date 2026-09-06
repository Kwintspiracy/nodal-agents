// spaces-list.test.ts — les automatisations se groupent à part, une ligne par
// automatisation, le dernier run en tête ; les conversations restent telles
// quelles, dans l'ordre reçu.

import { describe, it, expect } from 'vitest';
import { groupSpaces } from '../spaces-list.ts';
import type { SpaceListRow } from '../actions.ts';

const row = (over: Partial<SpaceListRow>): SpaceListRow => ({
  id: 'x',
  agentName: 'Alfred',
  agentSlug: 'alfred',
  agentAvatarUrl: null,
  channel: 'telegram',
  task: 'tâche',
  status: 'completed',
  costUsd: 0.01,
  inputTokens: 100,
  outputTokens: 10,
  createdAt: null,
  completedAt: null,
  conversationId: null,
  scheduleId: null,
  scheduleName: null,
  ...over,
});

describe('groupSpaces', () => {
  it('sépare les conversations des automatisations, et groupe celles-ci par automatisation', () => {
    const rows = [
      row({
        id: 'c3',
        channel: 'cron',
        scheduleId: 'S',
        scheduleName: 'Changelog',
        task: 'Goal: detect',
        status: 'completed',
        costUsd: 0.05,
      }),
      row({ id: 't1', channel: 'telegram', task: 'Rappelle-moi…' }),
      row({
        id: 'c2',
        channel: 'cron',
        scheduleId: 'S',
        scheduleName: 'Changelog',
        task: 'Goal: detect',
        status: 'failed',
        costUsd: 0.04,
      }),
      row({ id: 'd1', channel: 'api', task: 'Depuis le dashboard' }),
      row({
        id: 'c1',
        channel: 'cron',
        scheduleId: 'S',
        scheduleName: 'Changelog',
        task: 'Goal: detect',
        status: 'completed',
        costUsd: 0.01,
      }),
      row({
        id: 'w1',
        channel: 'cron',
        scheduleId: 'W',
        scheduleName: 'Veille hebdo',
        task: 'Veille',
      }),
    ];
    const g = groupSpaces(rows);
    expect(g.conversations.map((r) => r.id)).toEqual(['t1', 'd1']);
    expect(g.scheduled.map((s) => [s.key, s.name, s.runs.length, s.lastRun.id, s.failed])).toEqual([
      ['S', 'Changelog', 3, 'c3', 1],
      ['W', 'Veille hebdo', 1, 'w1', 0],
    ]);
    expect(g.scheduled[0]?.totalCostUsd).toBeCloseTo(0.1, 6);
  });

  it('une automatisation sans nom se groupe par id, sinon par tâche, et prend la première ligne de la tâche pour nom', () => {
    const rows = [
      row({
        id: 'a',
        channel: 'cron',
        scheduleId: null,
        scheduleName: null,
        task: 'Ligne un\nligne deux',
      }),
      row({
        id: 'b',
        channel: 'cron',
        scheduleId: null,
        scheduleName: null,
        task: 'Ligne un\nligne deux',
      }),
      row({ id: 'c', channel: 'cron', scheduleId: null, scheduleName: null, task: 'Autre' }),
    ];
    const g = groupSpaces(rows);
    expect(g.scheduled.map((s) => [s.name, s.runs.length])).toEqual([
      ['Ligne un', 2],
      ['Autre', 1],
    ]);
    expect(g.conversations).toEqual([]);
  });
});

describe('groupSpaces — le prérequis d’ordre', () => {
  it('prend le PREMIER run reçu comme dernier run : l’appelant trie du plus récent au plus ancien (listSpacesAction)', () => {
    const rows = [
      row({
        id: 'recent',
        channel: 'cron',
        scheduleId: 'S',
        createdAt: new Date('2026-09-06T10:00:00Z'),
      }),
      row({
        id: 'ancien',
        channel: 'cron',
        scheduleId: 'S',
        createdAt: new Date('2026-09-05T10:00:00Z'),
      }),
    ];
    expect(groupSpaces(rows).scheduled[0]?.lastRun.id).toBe('recent');
    // L'ordre inverse donnerait un dernier run faux : le contrat est l'ordre reçu.
    expect(groupSpaces([...rows].reverse()).scheduled[0]?.lastRun.id).toBe('ancien');
  });
});
