// WorkHeader.test.tsx — l'en-tête d'un fil (P2bis) : ce qu'il montre, et
// surtout ce qu'il TAIT quand la donnée n'existe pas.
//
// Rendu statique côté serveur (renderToStaticMarkup), comme les autres tests
// d'écran de ce dossier : pas de navigateur, on lit le HTML.

import { describe, it, expect, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import WorkBar from '../WorkBar.tsx';

// #132 — la barre porte désormais le réglage de densité, qui appelle une action
// serveur. `actions.ts` est `server-only` : le mock est ce qui rend la barre
// rendable ici, et c'est aussi la SONDE qui prouve ce que le clic envoie.
const setFeedDensityAction = vi.hoisted(() =>
  vi.fn(async (d: unknown) => ({ ok: true as const, data: d })),
);
vi.mock('@/lib/actions.ts', () => ({ setFeedDensityAction }));
// #232 — le retour de la barre est désormais `BackButton`, qui lit le chemin
// courant pour savoir d'où l'on vient. Ce qui se joue ICI est ce que la barre
// montre ; la règle de retour, elle, se prouve dans `BackButton.test.tsx`.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), back: vi.fn() }),
  usePathname: () => '/chat/c-1',
}));
import { threadAgents } from '../format.ts';
import type { FeedItem } from '@/lib/conversation-feed.ts';

const turn = (name: string, slug: string | null): FeedItem => ({
  kind: 'turn',
  index: 1,
  turn: 1,
  turnSource: 'audit',
  agent: { name, slug, avatarUrl: null },
  model: null,
  at: null,
  blocks: [],
  usage: null,
});

// #135 — un item de délégation dit aussi QUI a délégué. Dans ces fixtures la
// tête du fil est Alfred : c'est donc lui qui confie le travail.
const child = (name: string, slug: string | null, nested: FeedItem[] = []): FeedItem => ({
  kind: 'child',
  from: { name: 'Alfred', slug: 'alfred', avatarUrl: null },
  job: {
    id: `job-${slug ?? name}`,
    agentName: name,
    agentSlug: slug,
    agentAvatarUrl: null,
    status: 'completed',
    task: null,
    result: null,
    error: null,
    createdAt: null,
    completedAt: null,
    ...(nested.length > 0
      ? {
          feed: {
            items: nested,
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
        }
      : {}),
  },
});

describe('threadAgents', () => {
  it("garde l'ordre d'apparition et dédoublonne par slug, pas par nom", () => {
    const agents = threadAgents([
      turn('Alfred', 'alfred'),
      child('Le Relecteur', 'relecteur'),
      // Le même agent, renommé entre deux jobs : un seul avatar.
      turn('Alfred Le Grand', 'alfred'),
      // Deux agents distincts qui portent le même nom : deux avatars.
      child('Le Relecteur', 'relecteur-2'),
    ]);
    expect(agents.map((a) => a.key)).toEqual(['alfred', 'relecteur', 'relecteur-2']);
    expect(agents[0]?.name).toBe('Alfred');
  });

  it('descend dans le fil des délégués et ignore un agent sans nom ni slug', () => {
    const agents = threadAgents([
      turn('Alfred', 'alfred'),
      child('Le Codeur', 'codeur', [turn('Le Testeur', 'testeur')]),
      turn(null as unknown as string, null),
    ]);
    expect(agents.map((a) => a.key)).toEqual(['alfred', 'codeur', 'testeur']);
  });

  it('porte l’avatar de chaque agent, pour que la barre le montre', () => {
    const avecImage = {
      ...turn('Alfred', 'alfred'),
      agent: { name: 'Alfred', slug: 'alfred', avatarUrl: '/avatars/avatar-07.png' },
    };
    const agents = threadAgents([avecImage, child('Le Codeur', 'codeur')]);
    expect(agents.map((a) => a.avatarUrl)).toEqual(['/avatars/avatar-07.png', null]);
  });
});

describe('AvatarStack dans la barre — les tuiles du Figma', () => {
  it('montre le VRAI avatar quand l’agent en a un, les initiales sinon', () => {
    const html = renderToStaticMarkup(
      <WorkBar
        back={{ label: 'Back to channels', href: '/chat' }}
        agents={[
          { key: 'alfred', name: 'Alfred', avatarUrl: '/avatars/avatar-07.png' },
          { key: 'codeur', name: 'Le Codeur', avatarUrl: null },
        ]}
      />,
    );
    expect(html).toContain('src="/avatars/avatar-07.png"');
    expect(html).toContain('>LC<');
    // Des portraits RONDS côte à côte, sans chevauchement ni anneau (Figma
    // `AvatarStack` 53:10) ; le libellé est celui du composant.
    expect(html).toContain('rounded-full');
    expect(html).not.toContain('-ml-[7px]');
    expect(html).not.toContain('border-paper');
    expect(html).toContain('2 agents');
  });

  it('au-delà de quatre, une tuile « +N » compte le reste — et le libellé compte tout', () => {
    const html = renderToStaticMarkup(
      <WorkBar
        back={{ label: 'Back to channels', href: '/chat' }}
        agents={['Ada', 'Bo', 'Cy', 'Di', 'Ed', 'Fa'].map((name) => ({
          key: name.toLowerCase(),
          name,
          avatarUrl: null,
        }))}
      />,
    );
    expect(html).toContain('>+2<');
    expect(html).toContain('6 agents');
    // Les deux derniers ne sont pas dessinés en tuile.
    expect(html).not.toContain('title="Ed"');
    expect(html).not.toContain('title="Fa"');
  });
});

describe('WorkBar — la barre SOUS l’en-tête de page', () => {
  const back = { label: 'Back to spaces', href: '/spaces' };

  it('dit d’où l’on vient, qui a travaillé, et ouvre le dossier du projet', () => {
    const html = renderToStaticMarkup(
      <WorkBar
        back={back}
        agents={[
          { key: 'alfred', name: 'Alfred' },
          { key: 'relecteur', name: 'Le Relecteur' },
        ]}
        proofVerdict="green"
        filesHref="/spaces/proj-1/files"
      />,
    );
    // Le motif du DS, celui de « Back to agents » : un chevron, un mot.
    expect(html).toContain('Back to spaces');
    expect(html).toContain('href="/spaces"');
    expect(html).toContain('2 agents');
    expect(html).toContain('Verified');
    expect(html).toContain('/spaces/proj-1/files');
    expect(html).toContain('Files');
    // Le NOM et le CHEMIN ne sont pas ici : ils sont le titre et le sous-titre
    // de la page (Quentin, 07/09 — un en-tête maison n'existe pas dans le DS).
    // Aucune taille de police en pixels : que des tokens de l'échelle typo.
    expect(html).not.toMatch(/text-\[\d/);
  });

  it('va d’un bord à l’autre : 54 px, un fond, deux filets, ses propres gouttières (#135)', () => {
    const html = renderToStaticMarkup(<WorkBar back={back} agents={[]} />);
    // La barre dessinée porte SA géométrie : l'enveloppe à gouttières de
    // `PageShell` la coupait de chaque côté, et le filet s'arrêtait avec elle.
    expect(html).toMatch(/class="[^"]*h-\[54px\][^"]*"/);
    expect(html).toMatch(/class="[^"]*border-y border-rule-2[^"]*"/);
    expect(html).toMatch(/class="[^"]*bg-canvas[^"]*"/);
    expect(html).toMatch(/class="[^"]*px-5[^"]*lg:px-9[^"]*"/);
  });

  it('dit « 1 agent » au singulier', () => {
    const html = renderToStaticMarkup(
      <WorkBar back={back} agents={[{ key: 'a', name: 'Alfred' }]} />,
    );
    expect(html).toContain('1 agent');
    expect(html).not.toContain('1 agents');
  });

  it('sans preuve, aucune pastille ; sans projet, aucun bouton Files', () => {
    const html = renderToStaticMarkup(<WorkBar back={back} agents={[]} />);
    expect(html).not.toContain('Verified');
    expect(html).not.toContain('Checks failed');
    expect(html).not.toContain('Files');
    // Aucun agent : pas de « 0 agents ».
    expect(html).not.toContain('agents<');
  });

  it('une preuve rouge dit que les contrôles ont échoué, jamais « Verified »', () => {
    const html = renderToStaticMarkup(<WorkBar back={back} agents={[]} proofVerdict="red" />);
    expect(html).toContain('Checks failed');
    expect(html).not.toContain('Verified');
  });

  it('un verdict que l’écran ne connaît pas ne rend aucune pastille', () => {
    const html = renderToStaticMarkup(
      <WorkBar back={back} agents={[]} proofVerdict="infra_error" />,
    );
    expect(html).not.toContain('Verified');
    expect(html).not.toContain('Checks failed');
  });
});

// ─── Le réglage de densité (#135, #132) ──────────────────────────────────────
//
// L'assertion porte sur l'ARGUMENT reçu par l'action, jamais sur un compte
// d'appels (invariant #5) : ce qui compte n'est pas qu'un bouton ait été
// cliqué, c'est que la densité choisie parte bien vers la base.

describe('WorkBar — la densité de lecture @cap:suivre-execution/ecran', () => {
  it('montre les deux segments, et celui de la personne est le retenu', () => {
    const html = renderToStaticMarkup(
      <WorkBar back={{ label: 'Back', href: '/chat' }} agents={[]} density="unfolded" />,
    );
    expect(html).toContain('Show the work');
    expect(html).toContain('Folded');
    expect(html).toContain('Unfolded');
    // `aria-pressed` dit lequel est retenu — pas une classe de fond.
    const unfolded = /data-testid="density-unfolded"[^>]*/.exec(html)?.[0] ?? '';
    const folded = /data-testid="density-folded"[^>]*/.exec(html)?.[0] ?? '';
    expect(html).toContain('aria-pressed="true"');
    expect(`${unfolded}${folded}`).not.toBe('');
  });

  it('sans densité, la barre ne montre AUCUN réglage — la page d’un run n’en a pas', () => {
    const html = renderToStaticMarkup(
      <WorkBar back={{ label: 'Back', href: '/scheduled' }} agents={[]} />,
    );
    expect(html).not.toContain('Show the work');
    expect(html).not.toContain('density-folded');
  });

  it('cliquer « Unfolded » envoie « unfolded » à l’action', async () => {
    setFeedDensityAction.mockClear();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<WorkBar back={{ label: 'Back', href: '/chat' }} agents={[]} density="folded" />);
    });
    const segment = container.querySelector<HTMLButtonElement>('[data-testid="density-unfolded"]');
    if (!segment) throw new Error('la barre n’a pas dessiné le segment « Unfolded »');
    await act(async () => {
      segment.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(setFeedDensityAction.mock.calls.map((c) => c[0])).toEqual(['unfolded']);
    expect(segment.getAttribute('aria-pressed')).toBe('true');
  });
});
