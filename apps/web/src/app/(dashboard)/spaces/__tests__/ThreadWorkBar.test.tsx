// WorkHeader.test.tsx — l'en-tête d'un fil (P2bis) : ce qu'il montre, et
// surtout ce qu'il TAIT quand la donnée n'existe pas.
//
// Rendu statique côté serveur (renderToStaticMarkup), comme les autres tests
// d'écran de ce dossier : pas de navigateur, on lit le HTML.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ThreadWorkBar from '../ThreadWorkBar.tsx';

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
    failureHint: null,
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
      <ThreadWorkBar
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
      <ThreadWorkBar
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

describe('ThreadWorkBar — la barre SOUS l’en-tête de page', () => {
  it('dit qui a travaillé, et ouvre le dossier du projet', () => {
    const html = renderToStaticMarkup(
      <ThreadWorkBar
        agents={[
          { key: 'alfred', name: 'Alfred' },
          { key: 'relecteur', name: 'Le Relecteur' },
        ]}
        proofVerdict="green"
        filesHref="/spaces/proj-1/files"
      />,
    );
    // #242 — plus aucun retour dans la barre : elle ne porte que le contexte.
    expect(html).not.toContain('Back');
    expect(html).not.toContain('‹');
    expect(html).toContain('2 agents');
    expect(html).toContain('Verified');
    expect(html).toContain('/spaces/proj-1/files');
    expect(html).toContain('Files');
    // Le NOM et le CHEMIN ne sont pas ici : ils sont le titre et le sous-titre
    // de la page (Quentin, 07/09 — un en-tête maison n'existe pas dans le DS).
    // Aucune taille de police en pixels : que des tokens de l'échelle typo.
    expect(html).not.toMatch(/text-\[\d/);
  });

  it('un fil qui n’a RIEN à dire ne dessine pas de bandeau vide (#242)', () => {
    // Depuis que le retour est parti, une barre peut n'avoir aucun contenu :
    // 54 px de fond entre deux filets autour de rien ne sont pas un élément
    // d'interface. Elle disparaît.
    expect(renderToStaticMarkup(<ThreadWorkBar agents={[]} />)).toBe('');
  });

  it('va d’un bord à l’autre : 54 px, un fond, deux filets, ses propres gouttières (#135)', () => {
    const html = renderToStaticMarkup(<ThreadWorkBar agents={[{ key: 'a', name: 'Alfred' }]} />);
    // La barre dessinée porte SA géométrie : l'enveloppe à gouttières de
    // `PageShell` la coupait de chaque côté, et le filet s'arrêtait avec elle.
    expect(html).toMatch(/class="[^"]*h-\[54px\][^"]*"/);
    expect(html).toMatch(/class="[^"]*border-y border-rule-2[^"]*"/);
    expect(html).toMatch(/class="[^"]*bg-canvas[^"]*"/);
    expect(html).toMatch(/class="[^"]*px-5[^"]*lg:px-9[^"]*"/);
  });

  it('dit « 1 agent » au singulier', () => {
    const html = renderToStaticMarkup(<ThreadWorkBar agents={[{ key: 'a', name: 'Alfred' }]} />);
    expect(html).toContain('1 agent');
    expect(html).not.toContain('1 agents');
  });

  it('sans preuve, aucune pastille ; sans projet, aucun bouton Files', () => {
    // Un état suffit à faire exister la barre : ce qui est en jeu ici est ce
    // qu'elle TAIT, pas le fait qu'elle se dessine.
    const html = renderToStaticMarkup(<ThreadWorkBar agents={[]} status={<span>Idle</span>} />);
    expect(html).not.toContain('Verified');
    expect(html).not.toContain('Checks failed');
    expect(html).not.toContain('Files');
    // Aucun agent : pas de « 0 agents ».
    expect(html).not.toContain('agents<');
  });

  it('une preuve rouge dit que les contrôles ont échoué, jamais « Verified »', () => {
    const html = renderToStaticMarkup(<ThreadWorkBar agents={[]} proofVerdict="red" />);
    expect(html).toContain('Checks failed');
    expect(html).not.toContain('Verified');
  });

  it('un verdict que l’écran ne connaît pas ne rend aucune pastille', () => {
    const html = renderToStaticMarkup(<ThreadWorkBar agents={[]} proofVerdict="infra_error" />);
    expect(html).not.toContain('Verified');
    expect(html).not.toContain('Checks failed');
  });
});
