// RunPage.test.tsx — l'ORDRE des blocs de la page d'un run, et l'état de
// départ de sa chronologie.
//
// C'est la décision produit du 18/09 : un run est un tableau de bord, et ce
// tableau se lit du haut vers le bas — ce qui a été demandé, ce que le run a
// répondu, ce qu'il a livré, ce qui a été relu, ce qui a été prouvé, et enfin
// ce qu'il a fait. Un bloc qui remonte ou qui descend change ce qu'on lit en
// premier : l'ordre se prouve, il ne se relit pas à l'œil à chaque PR.
//
// La chronologie est REPLIÉE sur un run terminé (on vient lire ce qu'il a
// rendu) et OUVERTE tant qu'il court (on vient le regarder travailler).

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SpaceConversationView } from '@/lib/actions.ts';
import type { ConversationFeed, FeedItem } from '@/lib/conversation-feed.ts';

// `LiveRefresh` appelle `useRouter`, qui exige un routeur monté ; un rendu
// statique n'en a pas. Ce qui est en jeu ici est l'ORDRE des blocs, jamais la
// navigation.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

import RunPage, { RunBody } from '../RunPage.tsx';

const totals: ConversationFeed['totals'] = {
  turns: 2,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  cacheCreationTokens: 0,
  costUsd: null,
  llmDurationMs: 0,
  models: [],
};

const turn = (index: number, text: string): FeedItem => ({
  kind: 'turn',
  index,
  turn: index,
  turnSource: 'audit',
  agent: { name: 'Alfred', slug: 'alfred', avatarUrl: null },
  model: 'z-ai/glm-5.3',
  blocks: [{ kind: 'prose', text }],
  usage: null,
  at: null,
});

/** Une délégation du run : elle vit DANS la chronologie, jamais en haut de page. */
const child: FeedItem = {
  kind: 'child',
  job: {
    id: 'job-child',
    agentName: 'Reviewer C',
    agentSlug: 'reviewer-c',
    agentAvatarUrl: null,
    status: 'completed',
    task: 'relis le digest',
    result: 'rien à redire',
    error: null,
    createdAt: null,
    completedAt: null,
  },
  from: { name: 'Alfred', slug: 'alfred', avatarUrl: null },
};

const delivered: FeedItem = {
  kind: 'produced',
  jobId: 'job-1',
  verdict: { isWork: true, items: [], uncertain: 0, more: 0, unclassified: 0 },
  project: null,
  summary: {
    files: 0,
    filePaths: [],
    lines: null,
    tests: null,
    durationMs: 41_000,
    costUsd: 0.04,
    reviews: [],
    checks: [],
    verdict: null,
  },
};

const ORIGIN = { channel: 'cron', scheduleName: 'every Monday 09:00', chatId: null };
const TASK = 'Weekly digest of the open GitHub issues';
const STEP = 'Reading the issues opened this week.';
const REPLY = 'Digest posted. Fourteen issues were opened this week.';

function data(live: boolean): SpaceConversationView {
  return {
    job: {
      id: 'job-1',
      task: TASK,
      channel: 'cron',
      status: live ? 'processing' : 'completed',
      agentName: 'Alfred',
      agentSlug: 'alfred',
      agentAvatarUrl: null,
      createdAt: new Date('2026-09-18T09:00:00Z'),
      completedAt: live ? null : new Date('2026-09-18T09:00:41Z'),
      conversationId: null,
      parentJobId: null,
      scheduleName: 'every Monday 09:00',
    },
    feed: { items: [turn(1, STEP), turn(2, REPLY), delivered], totals },
    verdicts: [],
    verification: { sequences: [], skippedSurfaces: [], unconfigured: [], deliverables: [] },
    cost: {
      byAgent: [],
      totals: {
        calls: 0,
        inputTokens: 12_410,
        outputTokens: 1_180,
        cachedTokens: 8_900,
        cacheCreationTokens: 0,
        costUsd: 0.0423,
        unpricedCalls: 0,
        llmDurationMs: 0,
        durationMs: 41_200,
        humanWaitMs: 0,
        proofMs: 0,
      },
    },
    deliveries: [],
  };
}

describe('RunPage — l’ordre du tableau @cap:suivre-execution/ecran', () => {
  const html = renderToStaticMarkup(<RunBody data={data(false)} />);

  it('les blocs se suivent : demande, réponse, livraison, revue, preuve, activité', () => {
    const at = (needle: string): number => {
      const i = html.indexOf(needle);
      expect(i, `« ${needle} » est dans la page`).toBeGreaterThan(-1);
      return i;
    };
    const ordre = [
      at(TASK),
      at('data-testid="run-reply"'),
      at('>Delivered<'),
      at('data-testid="review-section"'),
      at('data-testid="verification-section"'),
      at('data-testid="activity-section"'),
    ];
    expect(ordre).toEqual([...ordre].sort((a, b) => a - b));
  });

  it('la page s’ouvre EN HAUT : sa zone de défilement ne suit pas le bas', () => {
    // Un run n'est pas un fil. L'écran de conversation saute en bas à
    // l'ouverture et suit ce qui arrive, donc la page d'un run s'ouvrait déjà
    // défilée (Quentin, 18/09). Elle demande maintenant l'inverse, et un run
    // qui court ne fait plus filer ce qu'on est en train de lire.
    const page = renderToStaticMarkup(
      <RunPage data={data(false)} back={{ label: 'Back to Scheduled', href: '/scheduled' }} />,
    );
    expect(page).toContain('data-follow="never"');
    expect(page).not.toContain('data-follow="bottom"');
  });

  it('le corps garde la largeur d’une page Nodal, calée à gauche', () => {
    // La BOÎTE de `PageShell`, à l'identique : la largeur maximale ET les
    // gouttières sur le MÊME élément, sans `mx-auto`. Portées séparément — les
    // gouttières sur la zone de défilement, la largeur ici — elles donnaient
    // un contenu de 1152 px au lieu de 1080, soit 72 px de plus que toutes les
    // autres pages (Quentin, deux fois).
    expect(html).toContain('class="max-w-6xl min-w-0 space-y-4 px-5 sm:px-8 lg:px-9"');
    expect(html).not.toContain('mx-auto');
  });

  it('la zone de défilement ne pousse plus rien sur les côtés', () => {
    // Sinon les deux boîtes s'emboîtent et la page s'élargit d'autant.
    const page = renderToStaticMarkup(
      <RunPage data={data(false)} back={{ label: 'Back to Scheduled', href: '/scheduled' }} />,
    );
    const scroller = /<div[^>]*data-thread-scroller[^>]*class="([^"]*)"/.exec(page)?.[1] ?? '';
    expect(scroller, 'la zone de défilement est rendue').not.toBe('');
    expect(scroller).not.toContain('px-5');
    expect(scroller).not.toContain('lg:px-9');
    expect(scroller).toContain('pt-6');
  });

  it('aucun lien vers le run parent ni vers un délégué : ils se lisent dans la chronologie', () => {
    // Un run qui DESCEND d'un autre et qui a délégué : ni l'un ni l'autre ne
    // gagne un lien en haut de page. Une délégation se lit là où elle a eu
    // lieu, dépliable dans la chronologie (décision Quentin, 18/09).
    const avecDelegation = data(false);
    const page = renderToStaticMarkup(
      <RunBody
        data={{
          ...avecDelegation,
          job: { ...avecDelegation.job, parentJobId: 'job-parent' },
          feed: { ...avecDelegation.feed, items: [...avecDelegation.feed.items, child] },
        }}
      />,
    );
    expect(page).not.toContain('job-parent');
    expect(page).not.toContain('job-child');
    expect(page).not.toContain('parent run');
  });

  it('l’en-tête porte l’agent, la routine, le modèle et les chiffres du run', () => {
    expect(html).toContain('Alfred');
    expect(html).toContain('scheduled · every Monday 09:00');
    expect(html).toContain('z-ai/glm-5.3');
    expect(html).toContain('$0.04');
    expect(html).toContain('41.2 s');
    expect(html).toContain('12,410');
  });

  it('la réponse est SORTIE du fil : elle se lit sans rien déplier', () => {
    expect(html).toContain(REPLY);
    // Et une seule fois : la chronologie repliée ne la reprend pas dessous.
    expect(html.split(REPLY)).toHaveLength(2);
  });

  it('la revue d’un run d’automatisation le dit, sans prétendre à un verdict', () => {
    expect(html).toContain('No review on this run');
    expect(html).toContain('0 verdicts');
  });

  it('le verdict d’une relecture se montre ICI aussi, pas seulement depuis Code', () => {
    // Le même run disait « aucune relecture » sur cette route et montrait le
    // verdict sur /code : les deux chargeurs lisent la même chose depuis le
    // 18/09, et la page dessine ce qu'elle reçoit.
    const avecVerdict = data(false);
    const page = renderToStaticMarkup(
      <RunBody
        data={{
          ...avecVerdict,
          verdicts: [
            {
              jobId: 'job-reviewer',
              verdict: 'request_changes',
              summary: 'Two majors closed, one minor left.',
              findings: [{ file: 'apps/web/src/lib/actions.ts', line: 13398, severity: 'major' }],
              counts: null,
              report: null,
            },
          ],
        }}
      />,
    );
    expect(page).toContain('1 verdict');
    expect(page).toContain('Two majors closed, one minor left.');
    expect(page).not.toContain('No review on this run');
  });

  it('la page dit DE QUEL run il s’agit', () => {
    // Sans les liens de délégation, plus rien ne l'identifiait : deux pages
    // ouvertes côte à côte se ressemblaient (Quentin, 18/09).
    expect(html).toContain('run job-1');
    expect(html).toContain('Copy');
  });

  it('la preuve n’est jamais muette, même quand rien n’a tourné', () => {
    expect(html).toContain('No proof ran for this process.');
  });

  it('la chronologie est LÀ, sur un run terminé comme sur un autre', () => {
    // Un seul bloc y reste : le tour qui portait la réponse l'a perdue (elle
    // est sortie en haut) et n'avait rien d'autre à montrer. L'autre tour, lui,
    // se lit sans rien déplier — la section ne se replie plus (18/09).
    expect(html).toContain('Activity · 1 step · 1 agent · 41 s');
    expect(html).toContain(STEP);
  });

  it('la demande ne se lit pas deux fois : la chronologie ne la reprend pas', () => {
    // Ce qu'un lecteur VOIT, pas ce que le balisage contient : le titre porte
    // aussi la demande dans son attribut `title` (le texte au survol).
    const lu = (page: string): string[] => page.replace(/<[^>]*>/g, ' ').split(TASK);
    // La carte de tête la porte deux fois : en titre, et en entier dessous.
    expect(lu(html)).toHaveLength(3);
    const avecDemande = data(false);
    const page = renderToStaticMarkup(
      <RunBody
        data={{
          ...avecDemande,
          feed: {
            ...avecDemande.feed,
            items: [
              { kind: 'request', text: TASK, origin: ORIGIN, at: null },
              ...avecDemande.feed.items,
            ],
          },
        }}
      />,
    );
    // Toujours deux fois, pas trois : l'item `request` a quitté la chronologie.
    expect(lu(page)).toHaveLength(3);
  });

  it('une demande qui dit AUTRE CHOSE que la tâche reste dans la chronologie', () => {
    const autre = data(false);
    const page = renderToStaticMarkup(
      <RunBody
        data={{
          ...autre,
          feed: {
            ...autre.feed,
            items: [
              { kind: 'request', text: 'Et le mois dernier ?', origin: ORIGIN, at: null },
              ...autre.feed.items,
            ],
          },
        }}
      />,
    );
    expect(page).toContain('Et le mois dernier ?');
  });
});

describe('RunPage — un run qui court @cap:suivre-execution/ecran', () => {
  const html = renderToStaticMarkup(<RunBody data={data(true)} />);

  it('la chronologie est là aussi : on est venu le regarder travailler', () => {
    expect(html).toContain(STEP);
  });

  it('rien ne sort du fil tant qu’il court : pas de réponse, pas de durée inventée', () => {
    expect(html).not.toContain('data-testid="run-reply"');
    expect(html).toContain('2 steps · 1 agent');
    expect(html).not.toContain('2 steps · 1 agent ·');
  });
});
