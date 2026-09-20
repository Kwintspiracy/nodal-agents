// stop-on-screens.test.tsx — LE BOUTON STOP SUR LES DEUX AUTRES ÉCRANS (#252).
//
// La page d'un run se prouve chez elle (`runs/__tests__/RunPage.test.tsx`) : ce
// fichier prend les deux routes qui restent, celles que l'issue nomme et que
// rien n'arrêtait — le fil d'une conversation dont un tour court, et la page
// d'une session de code.
//
// Les deux sont des composants SERVEUR : on les rend en HTML statique et on lit
// ce qui en sort. C'est exactement ce que le navigateur recevrait.
//
// ⚠️ AUCUN CLIC ICI. Le geste — la confirmation, l'appel à `cancelJobAction`,
// le rafraîchissement — se prouve sur le bouton lui-même
// (`components/ui/__tests__/StopRunButton.test.tsx`). Ce fichier ne prouve
// qu'une chose, celle qui manquait : le bouton EST là, et seulement quand il
// doit y être.

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

/** Ce que le fil rend, dans l'état que le cas demande. */
let filVivant = true;
/** L'étape du process de code, et sa nature. */
let codeStage = 'coding';
let codeKind: 'job' | 'chat' = 'job';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, back: () => {}, refresh: () => {} }),
  usePathname: () => '/chat/c-1',
  useSearchParams: () => new URLSearchParams(''),
  notFound: () => {
    throw new Error('notFound');
  },
}));

const totals = {
  turns: 1,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  cacheCreationTokens: 0,
  costUsd: null,
  llmDurationMs: 0,
  models: [],
};

const cost = {
  byAgent: [],
  cacheLost: { resumes: 0, tokens: 0, costUsd: null, unpricedResumes: 0 },
  totals: {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheCreationTokens: 0,
    costUsd: null,
    unpricedCalls: 0,
    llmDurationMs: 0,
    durationMs: 0,
    humanWaitMs: 0,
    proofMs: 0,
  },
};

vi.mock('@/lib/conversation-actions.ts', () => ({
  getConversationThreadAction: async () => ({
    ok: true,
    data: {
      conversation: {
        id: 'c-1',
        channel: 'dashboard',
        chatId: null,
        title: 'Un fil',
        agentId: 'a-1',
        agentName: 'Nestor',
        agentSlug: 'nestor',
        agentAvatarUrl: null,
        createdAt: new Date('2026-09-20T10:00:00Z'),
        currentProject: null,
      },
      feed: { items: [], totals },
      verification: { sequences: [], skippedSurfaces: [], unconfigured: [], deliverables: [] },
      cost,
      deliveries: [],
      live: filVivant,
      liveJobs: filVivant ? [{ id: 'job-du-fil', status: 'processing' }] : [],
      truncated: { messages: false, jobs: false },
      canReply: true,
    },
  }),
}));

vi.mock('@/lib/actions.ts', () => ({
  getFeedDensityAction: async () => ({ ok: true, data: 'folded' }),
  getAgentModelChoicesAction: async () => ({ ok: false, code: 'x', message: 'x' }),
  cancelJobAction: vi.fn(),
  getCodingProcessDetailAction: async () => ({
    ok: true,
    data: {
      header: {
        id: 'job-code',
        kind: codeKind,
        agentId: 'a-1',
        agentName: 'Nestor',
        origin: 'code',
        status: codeKind === 'job' ? 'processing' : null,
        stage: codeStage,
        task: 'Ajoute le bouton',
        costUsd: 0,
        providers: [],
        filesChanged: 0,
        activityAt: null,
        projectRoot: null,
        projectName: null,
        projectId: null,
        agentAvatarUrl: null,
        durationMs: null,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
      },
      activity: [],
      verdicts: [],
      changes: [],
      constatedBy: [],
      pipelineJobIds: ['job-code'],
      verificationRuns: [],
      deliverables: [],
    },
  }),
}));

import ChatThreadPage from '../chat/[id]/page.tsx';
import CodeProcessPage from '../code/[id]/page.tsx';

const STOP = 'data-testid="stop-run"';
const RANGEE = 'data-testid="action-row"';

describe('le fil d’une conversation @cap:suivre-execution/ecran', () => {
  it('porte le bouton Stop pendant qu’un tour court', async () => {
    filVivant = true;
    const html = renderToStaticMarkup(
      await ChatThreadPage({ params: Promise.resolve({ id: 'c-1' }) }),
    );
    expect(html).toContain(STOP);
    expect(html).toContain(RANGEE);
    // ET C'EST BIEN CE JOB-LÀ qu'il arrêterait (Reviewer C, passe 1) : une
    // inversion d'identifiant entre deux écrans laissait le bouton en place et
    // n'était vue par aucun test.
    expect(html).toContain('data-job-id="job-du-fil"');
    // DANS LA COLONNE DU FIL, 760 px : la boîte de `ConversationFeedView`, et
    // pas celle du corps d'un run (Reviewer C, passe 2).
    const rangee = html.slice(html.indexOf(RANGEE) - 400, html.indexOf(RANGEE));
    expect(rangee).toContain('max-w-[760px]');
    expect(rangee).not.toContain('max-w-6xl');
    // SOUS la barre et AVANT le fil : c'est la place de la rangée d'actions
    // (#242), et la seule où elle reste sous les yeux pendant que ça travaille.
    expect(html.indexOf('data-testid="work-bar"')).toBeLessThan(html.indexOf(RANGEE));
  });

  it('ne dessine rien quand aucun tour ne court', async () => {
    filVivant = false;
    const html = renderToStaticMarkup(
      await ChatThreadPage({ params: Promise.resolve({ id: 'c-1' }) }),
    );
    expect(html).not.toContain(STOP);
    expect(html).not.toContain(RANGEE);
  });
});

describe('la page d’une session de code @cap:suivre-execution/ecran', () => {
  it('porte le bouton Stop tant que le process code', async () => {
    codeKind = 'job';
    codeStage = 'coding';
    const html = renderToStaticMarkup(
      await CodeProcessPage({ params: Promise.resolve({ id: 'job-job-code' }) }),
    );
    expect(html).toContain(STOP);
    expect(html).toContain(RANGEE);
    expect(html).toContain('data-job-id="job-code"');
    // Une session de code est un RUN : la boîte de son corps, comme la page
    // d'un run, et pas la colonne d'un fil.
    const rangee = html.slice(html.indexOf(RANGEE) - 400, html.indexOf(RANGEE));
    expect(rangee).toContain('max-w-6xl');
    expect(rangee).not.toContain('max-w-[760px]');
  });

  it('ne le dessine PAS pour une session de chat de la CLI', async () => {
    // Une session de chat n'a pas de job à annuler, et le harnais qui tourne
    // dehors n'est pas à nous (hors périmètre de #252). Un bouton ici
    // promettrait un arrêt que rien ne ferait.
    codeKind = 'chat';
    codeStage = 'chat';
    const html = renderToStaticMarkup(
      await CodeProcessPage({ params: Promise.resolve({ id: 'job-code' }) }),
    );
    expect(html).not.toContain(STOP);
    expect(html).not.toContain(RANGEE);
  });
});
