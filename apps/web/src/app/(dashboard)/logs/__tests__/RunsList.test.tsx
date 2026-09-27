// RunsList.test.tsx — une colonne de coûts, une précision (#522).
//
// `$0.0080` au-dessus de `$0.01` : deux précisions dans une même colonne, les
// chiffres ne s'alignent plus. La table choisit la précision de la colonne et
// toutes ses lignes la suivent.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ActivityRunRow } from '@/lib/actions.ts';

vi.mock('@/lib/actions.ts', () => ({ listRunCallsAction: vi.fn() }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: unknown }) => (
    <a href={href}>{children as never}</a>
  ),
}));

const { default: RunsList } = await import('../RunsList.tsx');

const base: Omit<ActivityRunRow, 'id' | 'costUsd'> = {
  agentId: '33333333-3333-4333-8333-333333333333',
  agentName: 'Alfred',
  agentSlug: 'alfred',
  agentAvatarUrl: null,
  origin: { label: 'Telegram', detail: null },
  task: 'Résumé',
  status: 'completed',
  durationMs: 1200,
  callCount: 1,
  createdAt: new Date('2026-09-27T08:00:00.000Z'),
};

let container: HTMLDivElement;
let root: Root;
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function coutsAffiches(couts: (number | null)[]): Promise<string[]> {
  const runs = couts.map((costUsd, i) => ({
    ...base,
    id: `2222222${i}-2222-4222-8222-222222222222`,
    costUsd,
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<RunsList runs={runs} />);
  });
  return [...container.querySelectorAll('[data-testid="run-cost"]')].map(
    (c) => c.textContent ?? '',
  );
}

describe('RunsList — la colonne des coûts @cap:suivre-execution/ecran', () => {
  it('un coût sous le centime met TOUTE la colonne à quatre décimales', async () => {
    expect(await coutsAffiches([0.008, 0.0123, 0.52])).toEqual(['$0.0080', '$0.0123', '$0.5200']);
  });

  it('sans coût sous le centime, deux décimales pour toute la colonne', async () => {
    expect(await coutsAffiches([0.02, 1.2, 0])).toEqual(['$0.02', '$1.20', '$0.00']);
  });
});
