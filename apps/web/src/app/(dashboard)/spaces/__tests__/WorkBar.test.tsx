// WorkHeader.test.tsx — l'en-tête d'un fil (P2bis) : ce qu'il montre, et
// surtout ce qu'il TAIT quand la donnée n'existe pas.
//
// Rendu statique côté serveur (renderToStaticMarkup), comme les autres tests
// d'écran de ce dossier : pas de navigateur, on lit le HTML.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import WorkBar from '../WorkBar.tsx';
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
