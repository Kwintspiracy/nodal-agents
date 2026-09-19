// FullHeightWidth.test.tsx — les écrans qui remplissent VRAIMENT le cadre
// (#237, 19/09/2026).
//
// Le mode pleine hauteur du `PageShell` borne désormais sa colonne de contenu à
// `max-w-6xl`, comme le mode ordinaire : deux largeurs de lecture dans la même
// application, c'était le constat du propriétaire sur /settings. Mais trois
// écrans ne veulent pas de cette borne, et ils passent `fluid` pour la retirer —
// un fil de chat, dont la saisie tient le bas de l'écran ; la page d'un run,
// qui reprend sa forme ; la page d'un projet, dont le panneau prend déjà 400 px
// à droite.
//
// UN OUBLI DE `fluid` NE SE VOIT PAS EN LISANT LE CODE : la page compile, les
// tests passent, et l'écran rétrécit de pleine largeur à 1152 px. C'est ce qui
// est arrivé à ces deux appelants en écrivant la borne (trouvé par settings-pr
// en reprenant le composant), et c'est pourquoi le fait s'assert ici plutôt que
// de se relire.
//
// Rendu statique côté serveur : on lit le HTML produit. Les lectures sont
// doublées — ce qui est prouvé est une CLASSE, pas une donnée.

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound');
  },
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/chat/c-1',
}));

const fil = {
  conversation: {
    id: 'c-1',
    channel: 'dashboard',
    chatId: null,
    title: 'Un fil',
    agentId: 'a-1',
    agentName: 'Builder A',
    agentSlug: 'builder-a',
    agentAvatarUrl: null,
    createdAt: new Date('2026-09-19T10:00:00Z'),
    currentProject: null,
  },
  feed: {
    items: [],
    totals: {
      turns: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cacheCreationTokens: 0,
      costUsd: null,
      llmDurationMs: 0,
      models: [],
    },
  },
  verification: { sequences: [], skippedSurfaces: [], unconfigured: [], deliverables: [] },
  cost: {
    byAgent: [],
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
  },
  deliveries: [],
  live: false,
  canReply: false,
};

vi.mock('@/lib/conversation-actions.ts', () => ({
  getConversationThreadAction: async () => ({ ok: true, data: fil }),
}));

vi.mock('@/lib/actions.ts', () => ({
  getFeedDensityAction: async () => ({ ok: true, data: 'folded' }),
  getAgentModelChoicesAction: async () => ({ ok: false, code: 'x', message: 'x' }),
}));

import PageShell from '../PageShell';
import RunScreen from '@/app/(dashboard)/runs/RunScreen.tsx';
import ChatThreadPage from '@/app/(dashboard)/chat/[id]/page.tsx';

/** La borne que ces écrans ne doivent PAS porter. */
const BORNE = 'max-w-6xl';

describe('PageShell — la borne du mode pleine hauteur @cap:suivre-execution/ecran', () => {
  it('borne un écran pleine hauteur ORDINAIRE : c’est le défaut', () => {
    const html = renderToStaticMarkup(
      <PageShell fill title="Ordinaire">
        <p>x</p>
      </PageShell>,
    );
    expect(html).toContain(BORNE);
  });

  it('la page d’un RUN rend sans la borne', () => {
    const html = renderToStaticMarkup(
      <RunScreen
        avatarName="Builder A"
        avatarUrl={null}
        title="Un run"
        subtitle="code"
        back={{ label: 'Back to Activity', href: '/logs' }}
        agents={[]}
      >
        <p data-testid="corps">le corps du run</p>
      </RunScreen>,
    );
    expect(html).toContain('le corps du run');
    expect(html).not.toContain(BORNE);
  });

  it('un FIL de chat rend sans la borne', async () => {
    const html = renderToStaticMarkup(
      await ChatThreadPage({ params: Promise.resolve({ id: 'c-1' }) }),
    );
    expect(html).toContain('Un fil');
    expect(html).not.toContain(BORNE);
  });
});
