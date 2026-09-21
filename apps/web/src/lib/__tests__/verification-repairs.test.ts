// verification-repairs.test.ts — ce qu'une preuve REJOUÉE change pour les
// écrans (issue #375).
//
// Le fait prouvé ici : un livrable qui porte deux séquences (celle qui a rougi,
// celle qui a suivi la réparation) ne compte QUE la dernière. Sans ce tri, un
// run dont la preuve finit verte se lit « 1 / 2 » et « Proof failed ».

import { describe, it, expect } from 'vitest';
import { lastSequencePerDeliverable } from '../verification-repairs.ts';

const at = (iso: string): Date => new Date(iso);

interface Ligne {
  deliverableType: string;
  canonicalKey: string;
  sequenceId: string;
  createdAt: Date | null;
  source: string;
  command: string;
  verdict: string;
}

const ligne = (
  sequenceId: string,
  verdict: string,
  createdAt: string,
  canonicalKey = 'd:/apps/demo',
  deliverableType = 'code_project',
  source = 'job',
): Ligne => ({
  deliverableType,
  canonicalKey,
  sequenceId,
  createdAt: at(createdAt),
  source,
  command: 'pnpm test',
  verdict,
});

describe('lastSequencePerDeliverable @cap:verifier-un-livrable/moteur', () => {
  it('un livrable réparé ne garde que la séquence qui a suivi la réparation', () => {
    const gardees = lastSequencePerDeliverable([
      ligne('seq-rouge', 'red', '2026-09-21T10:00:00Z'),
      ligne('seq-verte', 'green', '2026-09-21T10:05:00Z'),
    ]);

    expect(gardees).toHaveLength(1);
    expect(gardees[0]?.sequenceId).toBe('seq-verte');
    expect(gardees[0]?.verdict).toBe('green');
  });

  it('les commandes d’une même séquence restent toutes, dans l’ordre', () => {
    const gardees = lastSequencePerDeliverable([
      ligne('seq-1', 'red', '2026-09-21T10:00:00Z'),
      { ...ligne('seq-2', 'green', '2026-09-21T10:05:00Z'), command: 'tsc --noEmit' },
      { ...ligne('seq-2', 'green', '2026-09-21T10:05:01Z'), command: 'pnpm test' },
    ]);

    expect(gardees.map((r) => r.command)).toEqual(['tsc --noEmit', 'pnpm test']);
  });

  it('deux livrables gardent CHACUN leur dernière séquence', () => {
    const gardees = lastSequencePerDeliverable([
      ligne('a-1', 'red', '2026-09-21T10:00:00Z', 'd:/apps/a'),
      ligne('a-2', 'green', '2026-09-21T10:05:00Z', 'd:/apps/a'),
      ligne('b-1', 'green', '2026-09-21T10:01:00Z', 'd:/apps/b'),
    ]);

    expect(gardees.map((r) => r.sequenceId)).toEqual(['a-2', 'b-1']);
  });

  it('même clé, deux TYPES de livrable : ce sont deux livrables', () => {
    const gardees = lastSequencePerDeliverable([
      ligne('doc-1', 'green', '2026-09-21T10:00:00Z', 'd:/apps/x', 'document'),
      ligne('proj-1', 'red', '2026-09-21T10:05:00Z', 'd:/apps/x', 'code_project'),
    ]);

    expect(gardees.map((r) => r.sequenceId)).toEqual(['doc-1', 'proj-1']);
  });

  it('sans date, l’ordre d’arrivée tranche — la dernière ligne gagne', () => {
    const gardees = lastSequencePerDeliverable([
      { ...ligne('vieille', 'red', '2026-09-21T10:00:00Z'), createdAt: null },
      { ...ligne('recente', 'green', '2026-09-21T10:00:00Z'), createdAt: null },
    ]);

    expect(gardees.map((r) => r.sequenceId)).toEqual(['recente']);
  });

  it('la preuve d’un RELECTEUR ne masque pas celle du travail', () => {
    // Avant cette porte, l'encart montrait les deux. Ce qu'on retire est le
    // doublon de la réparation, pas la preuve de quelqu'un d'autre.
    const gardees = lastSequencePerDeliverable([
      ligne('du-job', 'red', '2026-09-21T10:00:00Z'),
      ligne(
        'du-relecteur',
        'green',
        '2026-09-21T10:05:00Z',
        'd:/apps/demo',
        'code_project',
        'reviewer',
      ),
    ]);

    expect(gardees.map((r) => r.sequenceId)).toEqual(['du-job', 'du-relecteur']);
  });

  it('aucune ligne : aucune ligne', () => {
    expect(lastSequencePerDeliverable([])).toEqual([]);
  });
});
