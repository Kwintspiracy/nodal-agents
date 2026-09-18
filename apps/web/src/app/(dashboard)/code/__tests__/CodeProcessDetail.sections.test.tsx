// CodeProcessDetail.sections.test.tsx — la page d'un process de code, lue
// comme un RUN.
//
// Depuis le 18/09 les trois routes montrent un run dans les mêmes blocs et
// dans le même ordre. Ce qui se prouve ici est donc l'ORDRE — ce qu'on lit en
// premier, en second — et le fait que l'activité est LÀ, dépliée, sans filtre
// à cliquer.
//
// Rendu dans un vrai DOM (jsdom) : la sonde et les approbations sont des
// actions serveur, remplacées ; tout le reste est le vrai composant.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CodingProcessDetail } from '@/lib/actions.ts';
import CodeProcessDetail from '../[id]/CodeProcessDetail.tsx';

const getCodingProcessDetailAction = vi.hoisted(() =>
  vi.fn(async () => ({ ok: false as const, code: 'unused', message: 'unused' })),
);
const listApprovalsAction = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true as const, data: [] as never[] })),
);

vi.mock('@/lib/actions.ts', () => ({
  getCodingProcessDetailAction,
  listApprovalsAction,
  // Importées par ApprovalActions, que ce module charge.
  resolveApprovalAction: vi.fn(),
  setAgentApprovalRuleAction: vi.fn(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: unknown }) => (
    <a href={href}>{children as never}</a>
  ),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const TASK = 'Unfolding a block must not move the scroll';

const detail = (): CodingProcessDetail => ({
  header: {
    id: JOB_ID,
    kind: 'job',
    agentId: null,
    agentName: 'Dev C',
    origin: 'api',
    status: 'completed',
    stage: 'done',
    task: TASK,
    costUsd: 1.92,
    providers: ['claude'],
    filesChanged: 1,
    activityAt: '2026-09-18T10:00:00.000Z',
    projectPath: 'D:/APPS/NodalAI',
    projectName: 'NodalAI',
    projectId: 'project-1',
    agentAvatarUrl: '/avatars/dev-c.png',
    sessionType: 'coding',
    durationMs: 408_000,
    inputTokens: 184_300,
    outputTokens: 9_720,
    cachedTokens: 151_000,
  },
  activity: [
    {
      kind: 'call',
      id: 'call-1',
      toolName: 'cli:Bash',
      toolInput: { command: 'pnpm exec vitest run ThreadScroller' },
      toolOutput: 'Tests 24 passed (24)',
      durationMs: 1400,
      createdAt: '2026-09-18T09:59:00.000Z',
      delegatedFrom: null,
    },
    {
      kind: 'call',
      id: 'call-2',
      toolName: 'review_verdict',
      toolInput: { verdict: 'approve' },
      toolOutput: '{"ok":true}',
      durationMs: 20,
      createdAt: '2026-09-18T09:59:30.000Z',
      delegatedFrom: { jobId: 'child-1', agentName: 'Reviewer C', agentAvatarUrl: null },
    },
    {
      kind: 'turn',
      jobId: JOB_ID,
      turn: 1,
      inputTokens: 4_120,
      outputTokens: 380,
      cachedTokens: 3_900,
      cacheCreationTokens: null,
      modelUsage: null,
      costUsd: 0.011,
    },
  ],
  verdicts: [
    {
      jobId: 'child-1',
      verdict: 'request_changes',
      summary: 'Two majors closed, one minor left.',
      findings: [
        {
          file: 'apps/web/src/lib/actions.ts',
          line: 13398,
          severity: 'major',
          issue: 'The timeline returns the raw tool output.',
        },
      ],
      counts: null,
    },
  ],
  changes: [
    {
      filePath: 'apps/web/src/app/page.tsx',
      addedLines: 1,
      removedLines: 1,
      edits: [
        {
          filePath: 'apps/web/src/app/page.tsx',
          kind: 'edit',
          oldText: 'const answer = 41;',
          newText: 'const answer = 42;',
        },
      ],
    },
  ],
  pipelineJobIds: [JOB_ID],
  verificationRuns: [
    {
      sequenceId: 'seq-1',
      jobId: JOB_ID,
      deliverableType: 'code_project',
      canonicalKey: 'd:/apps/nodalai',
      verdict: 'green',
      startedAt: '2026-09-18T09:58:00.000Z',
      runs: [
        {
          jobId: JOB_ID,
          sequenceId: 'seq-1',
          commandRank: 1,
          command: 'pnpm --filter @nodal-agents/web typecheck',
          exitCode: 0,
          outcomeKind: 'exit',
          durationMs: 48_100,
          verdict: 'green',
          testedGeneration: 1,
          testedEpoch: 0,
          createdAt: '2026-09-18T09:58:00.000Z',
        },
      ],
    },
  ],
  verificationSkippedSurfaces: [],
  verificationUnconfigured: [],
});

let container: HTMLDivElement;
let root: Root;

async function render(initial: CodingProcessDetail): Promise<void> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<CodeProcessDetail detail={initial} />);
  });
}

beforeEach(() => {
  getCodingProcessDetailAction.mockClear();
  listApprovalsAction.mockClear();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe('CodeProcessDetail — un process de code se lit comme un run @cap:suivre-execution/ecran', () => {
  it('le corps ne relit PLUS le détail lui-même — c’est la page qui se relit', async () => {
    // La sonde côté client ne rafraîchissait que ce corps : la barre du haut
    // restait sur l'état du chargement, sans sa pastille (Quentin, 18/09). La
    // fraîcheur passe maintenant par `LiveRefresh`, qui fait re-rendre le
    // SERVEUR, barres comprises. Le corps, lui, ne va plus rien chercher.
    await render({ ...detail(), header: { ...detail().header, stage: 'coding' } });
    expect(getCodingProcessDetailAction).not.toHaveBeenCalled();
  });

  it('les blocs se suivent : demande, livraison, revue, preuve, fichiers, activité', async () => {
    await render(detail());
    const html = container.innerHTML;
    const at = (needle: string): number => {
      const i = html.indexOf(needle);
      expect(i, `« ${needle} » est dans la page`).toBeGreaterThan(-1);
      return i;
    };
    const ordre = [
      at(TASK),
      at('>Delivered<'),
      at('data-testid="review-section"'),
      at('data-testid="verification-section"'),
      at('Files · 1'),
      at('data-testid="activity-section"'),
    ];
    expect(ordre).toEqual([...ordre].sort((a, b) => a - b));
  });

  it('l’en-tête porte l’agent, le projet, le harnais et les sept chiffres', async () => {
    await render(detail());
    const text = container.textContent ?? '';
    expect(text).toContain('Dev C');
    expect(text).toContain('code · NodalAI');
    expect(text).toContain('claude');
    expect(text).toContain('$1.92');
    expect(text).toContain('6 min 48');
    expect(text).toContain('184,300');
    expect(text).toContain('151,000');
  });

  it('la revue montre son verdict, et le constat s’ouvre avec son fichier et sa ligne', async () => {
    await render(detail());
    expect(container.textContent).toContain('1 verdict');
    expect(container.textContent).not.toContain('apps/web/src/lib/actions.ts:13398');

    const row = container.querySelector('[data-testid="review-row"]');
    await act(async () => {
      (row as HTMLElement).click();
    });
    const text = container.textContent ?? '';
    expect(text).toContain('apps/web/src/lib/actions.ts:13398');
    expect(text).toContain('major');
    expect(text).toContain('The timeline returns the raw tool output.');
  });

  it('ce qui a été livré se lit en haut : fichiers, lignes, preuve', async () => {
    await render(detail());
    const text = container.textContent ?? '';
    expect(text).toContain('Delivered');
    expect(text).toContain('apps/web/src/app/page.tsx');
    expect(text).toContain('1 / 1');
  });

  it('l’activité est LÀ, sans filtre à cliquer, chaque appel dans un bloc du fil', async () => {
    await render(detail());
    const text = container.textContent ?? '';
    // Le titre de la section compte les pas et les agents.
    expect(text).toContain('Activity · 3 steps · 2 agents · 6 min 48');
    // Les rangées de filtre par agent ont disparu (Quentin, 18/09).
    expect(text).not.toContain('All');
    expect(container.querySelector('[role="tablist"]')).toBeNull();

    // Un appel se lit comme dans le fil : le nom de l'outil, son argument, sa
    // durée — et le délégué qui l'a passé quand il y en a un.
    expect(text).toContain('Bash');
    expect(text).toContain('pnpm exec vitest run ThreadScroller');
    expect(text).toContain('1.4 s');
    expect(text).toContain('delegated · Reviewer C');
    // Le marqueur de tour rend sa ligne d'appel de modèle.
    expect(text).toContain('4,120 in');
    expect(text).toContain('3,900 cached');
  });

  it('un appel déplié montre son entrée et son résultat', async () => {
    await render(detail());
    const rows = Array.from(container.querySelectorAll('button[aria-expanded]')).filter((b) =>
      (b.textContent ?? '').includes('Bash'),
    );
    expect(rows).toHaveLength(1);
    await act(async () => {
      (rows[0] as HTMLElement).click();
    });
    const text = container.textContent ?? '';
    expect(text).toContain('Input');
    expect(text).toContain('Result');
    expect(text).toContain('Tests 24 passed (24)');
  });
});
