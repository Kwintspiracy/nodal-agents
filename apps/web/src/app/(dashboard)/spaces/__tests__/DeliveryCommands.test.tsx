// DeliveryCommands.test.tsx — CHAQUE COMMANDE DIT SON ISSUE (#395).
//
// La section « Commands » listait tout ce qu'un run avait lancé, sans dire ce
// qu'une commande avait rendu : celle qui sortait en 1 se lisait comme celle
// qui sortait en 0. Et rien ne disait en quoi cette liste diffère de « Proof »
// juste dessous, qui porte les vérifications que l'agent a déclarées (Quentin,
// 21/09 : « est-ce que ce sont seulement les commandes de test ? »).
//
// Les cas portent sur le DOM rendu : le mot, sa couleur, et son absence.

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// Le bouton Stop de l'encart lit le routeur de Next ; hors de l'app, il n'y a
// pas de routeur monté.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

import DeliveryBlock, { commandOutcome } from '../DeliveryBlock.tsx';
import type { DeliveryCommand, DeliverySummary } from '@/lib/conversation-feed.ts';

const commande = (over: Partial<DeliveryCommand>): DeliveryCommand => ({
  label: 'pnpm test',
  observed: true,
  purpose: null,
  exitCode: 0,
  timedOut: false,
  blocked: false,
  ...over,
});

const EMPTY: DeliverySummary = {
  repairs: 0,
  files: 0,
  fileChanges: [],
  lines: null,
  tests: null,
  durationMs: null,
  costUsd: null,
  reviews: [],
  checks: [],
  verdict: null,
  review: null,
  changesRequested: false,
  commands: [],
  produced: true,
  ended: null,
  live: null,
};

const rendu = (commands: DeliveryCommand[]): string =>
  renderToStaticMarkup(<DeliveryBlock summary={{ ...EMPTY, commands }} jobId={null} />);

describe('commandOutcome — ce qu’une ligne dit de son issue @cap:verifier-un-livrable/moteur', () => {
  it('une sortie à zéro ne dit rien ; tout le reste se dit en un mot', () => {
    expect(commandOutcome(commande({ exitCode: 0 }))).toBeNull();
    expect(commandOutcome(commande({ exitCode: 1 }))).toBe('exit 1');
    expect(commandOutcome(commande({ exitCode: 137 }))).toBe('exit 137');
    expect(commandOutcome(commande({ exitCode: null, timedOut: true }))).toBe('timed out');
    expect(commandOutcome(commande({ exitCode: null, blocked: true }))).toBe('blocked');
    // Une issue INCONNUE ne s'invente pas : ni « exit 0 », qui affirmerait un
    // succès, ni un mot rouge, qui affirmerait une panne (invariant #4).
    expect(commandOutcome(commande({ exitCode: null }))).toBeNull();
  });
});

describe('la section Commands @cap:verifier-un-livrable/ecran', () => {
  it('une commande qui a lâché porte « exit 1 » dans la couleur de l’attention', () => {
    const html = rendu([commande({ label: 'pnpm test', exitCode: 1 })]);
    expect(html).toContain('exit 1');
    expect(html).toMatch(/text-warn[^>]*>exit 1</);
  });

  it('une commande qui a rendu 0 ne porte AUCUNE issue', () => {
    const html = rendu([commande({ label: 'pnpm build', exitCode: 0 })]);
    expect(html).toContain('pnpm build');
    expect(html).not.toContain('exit ');
    expect(html).not.toContain('delivery-command-outcome');
  });

  it('une commande refusée par une règle porte « blocked »', () => {
    const html = rendu([commande({ label: 'rm -rf out', blocked: true, exitCode: null })]);
    expect(html).toContain('rm -rf out');
    expect(html).toMatch(/text-warn[^>]*>blocked</);
  });

  it('le titre dit ce que la liste est, et ce que Proof est', () => {
    const html = rendu([commande({})]);
    expect(html).toContain(
      'Every command the run executed. Proof below lists the checks the agent declared.',
    );
    // La copie d'écran du dépôt n'a pas de tiret cadratin.
    const section = html.slice(html.indexOf('Commands'));
    expect(section).not.toContain('—');
  });

  it('les trois issues cohabitent dans la même liste, chacune sur sa ligne', () => {
    const html = rendu([
      commande({ label: 'pnpm lint', exitCode: 0 }),
      commande({ label: 'pnpm test', exitCode: 1 }),
      commande({ label: 'rm -rf out', blocked: true, exitCode: null }),
    ]);
    expect(html.match(/data-testid="delivery-command"/g)).toHaveLength(3);
    expect(html.match(/data-testid="delivery-command-outcome"/g)).toHaveLength(2);
  });
});
