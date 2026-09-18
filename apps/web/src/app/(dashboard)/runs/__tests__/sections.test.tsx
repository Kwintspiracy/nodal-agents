// sections.test.tsx — les deux lignes repliables de la page d'un run.
//
// Activity : un clic l'ouvre et montre la chronologie. C'est la promesse du
// tableau — replié ne veut pas dire perdu.
// Review : avec des verdicts, la ligne s'ouvre et montre les constats, fichier
// et ligne compris. Sans verdict, elle se dessine mais ne s'ouvre pas : il n'y
// a rien dessous, et un chevron qui ne fait rien est un bouton menteur.

import { describe, it, expect, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import ActivitySection from '../ActivitySection.tsx';
import ReviewSection from '../ReviewSection.tsx';
import type { CodingVerdictView } from '@/lib/actions.ts';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

async function mount(node: React.ReactNode): Promise<HTMLDivElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
  });
  return host;
}

async function click(el: Element | null): Promise<void> {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

describe('ActivitySection @cap:suivre-execution/ecran', () => {
  it('repliée, un clic montre la chronologie', async () => {
    const host = await mount(
      <ActivitySection label="9 steps · 3 agents · 41 s" live={false}>
        <p>file_search in apps/web</p>
      </ActivitySection>,
    );
    expect(host.textContent).toContain('9 steps · 3 agents · 41 s');
    expect(host.textContent).not.toContain('file_search');

    await click(host.querySelector('[data-testid="activity-row"]'));
    expect(host.textContent).toContain('file_search in apps/web');
  });
});

const VERDICT: CodingVerdictView = {
  jobId: 'job-1',
  verdict: 'request_changes',
  summary: 'Two majors closed, one minor left.',
  findings: [
    {
      file: 'apps/web/src/lib/actions.ts',
      line: 13398,
      severity: 'major',
      issue: 'Raw tool output.',
    },
  ],
  counts: null,
};

describe('ReviewSection @cap:suivre-execution/ecran', () => {
  it('avec un verdict, un clic montre le constat, son fichier et sa ligne', async () => {
    const host = await mount(<ReviewSection verdicts={[VERDICT]} />);
    expect(host.textContent).toContain('1 verdict');
    expect(host.textContent).toContain('Two majors closed, one minor left.');
    expect(host.textContent).not.toContain('apps/web/src/lib/actions.ts:13398');

    await click(host.querySelector('[data-testid="review-row"]'));
    expect(host.textContent).toContain('apps/web/src/lib/actions.ts:13398');
    expect(host.textContent).toContain('major');
    expect(host.textContent).toContain('Raw tool output.');
  });

  it('sans verdict, la ligne le dit et ne s’ouvre pas', async () => {
    const host = await mount(<ReviewSection verdicts={[]} />);
    expect(host.textContent).toContain('No review on this run');
    expect(host.textContent).toContain('0 verdicts');

    await click(host.querySelector('[data-testid="review-row"]'));
    expect(host.querySelector('[data-testid="review-verdict"]')).toBeNull();
  });
});
