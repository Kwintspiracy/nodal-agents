// verification-repairs.test.ts — ce qu'une preuve REJOUÉE change pour les
// écrans (issue #375).
//
// Le fait prouvé ici : un job qui a rejoué sa preuve sur un livrable ne compte
// QUE la dernière séquence. Sans ce tri, un run dont la preuve finit verte se
// lit « 1 / 2 » et « Proof failed ».
//
// Et son revers, tout aussi important : ce filtre ne replie QUE le doublon
// d'une réparation. La preuve d'un autre job, ou d'un relecteur, sur le même
// livrable reste entière.

import { describe, it, expect } from 'vitest';
import {
  lastSequencePerDeliverable,
  lastSequenceViewPerDeliverable,
} from '../verification-repairs.ts';

interface Ligne {
  jobId: string | null;
  deliverableType: string;
  canonicalKey: string;
  source: string;
  sequenceId: string;
  createdAt: Date;
  command: string;
  verdict: string;
}

const ligne = (
  sequenceId: string,
  verdict: string,
  createdAt: string,
  over: Partial<Ligne> = {},
): Ligne => ({
  jobId: 'job-1',
  deliverableType: 'code_project',
  canonicalKey: 'd:/apps/demo',
  source: 'job',
  sequenceId,
  createdAt: new Date(createdAt),
  command: 'pnpm test',
  verdict,
  ...over,
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
      ligne('seq-2', 'green', '2026-09-21T10:05:00Z', { command: 'tsc --noEmit' }),
      ligne('seq-2', 'green', '2026-09-21T10:05:01Z', { command: 'pnpm test' }),
    ]);

    expect(gardees.map((r) => r.command)).toEqual(['tsc --noEmit', 'pnpm test']);
  });

  it('deux livrables gardent CHACUN leur dernière séquence', () => {
    const gardees = lastSequencePerDeliverable([
      ligne('a-1', 'red', '2026-09-21T10:00:00Z', { canonicalKey: 'd:/apps/a' }),
      ligne('a-2', 'green', '2026-09-21T10:05:00Z', { canonicalKey: 'd:/apps/a' }),
      ligne('b-1', 'green', '2026-09-21T10:01:00Z', { canonicalKey: 'd:/apps/b' }),
    ]);

    expect(gardees.map((r) => r.sequenceId)).toEqual(['a-2', 'b-1']);
  });

  it('même clé, deux TYPES de livrable : ce sont deux livrables', () => {
    const gardees = lastSequencePerDeliverable([
      ligne('doc-1', 'green', '2026-09-21T10:00:00Z', { deliverableType: 'document' }),
      ligne('proj-1', 'red', '2026-09-21T10:05:00Z'),
    ]);

    expect(gardees.map((r) => r.sequenceId)).toEqual(['doc-1', 'proj-1']);
  });

  it('la preuve d’un DÉLÉGUÉ sur le même projet n’est pas effacée par celle de sa tête', () => {
    // Le cas nommé par la revue : un délégué prouve le projet, puis la
    // finalisation de la tête le prouve aussi. Personne n'a rejoué quoi que ce
    // soit — les deux preuves restent.
    const gardees = lastSequencePerDeliverable([
      ligne('du-delegue', 'green', '2026-09-21T09:58:00Z', { jobId: 'job-delegue' }),
      ligne('de-la-tete', 'green', '2026-09-21T10:00:00Z', { jobId: 'job-tete' }),
    ]);

    expect(gardees.map((r) => r.sequenceId)).toEqual(['du-delegue', 'de-la-tete']);
  });

  it('la preuve d’un RELECTEUR ne masque pas celle du travail', () => {
    const gardees = lastSequencePerDeliverable([
      ligne('du-job', 'red', '2026-09-21T10:00:00Z'),
      ligne('du-relecteur', 'green', '2026-09-21T10:05:00Z', { source: 'reviewer' }),
    ]);

    expect(gardees.map((r) => r.sequenceId)).toEqual(['du-job', 'du-relecteur']);
  });

  it('à date ÉGALE, la dernière arrivée gagne — le tri reste total', () => {
    // Sans cette règle, deux rendus du même fil pourraient montrer deux
    // séquences différentes (Reviewer C, passe 2).
    const gardees = lastSequencePerDeliverable([
      ligne('premiere', 'red', '2026-09-21T10:00:00Z'),
      ligne('seconde', 'green', '2026-09-21T10:00:00Z'),
    ]);

    expect(gardees.map((r) => r.sequenceId)).toEqual(['seconde']);
  });

  it('aucune ligne : aucune ligne', () => {
    expect(lastSequencePerDeliverable([])).toEqual([]);
  });
});

describe('lastSequenceViewPerDeliverable @cap:verifier-un-livrable/moteur', () => {
  const sequence = (
    sequenceId: string,
    startedAt: string,
    over: { jobId?: string; canonicalKey?: string } = {},
  ) => ({
    jobId: over.jobId ?? 'job-1',
    deliverableType: 'code_project',
    canonicalKey: over.canonicalKey ?? 'd:/apps/demo',
    source: 'job',
    sequenceId,
    startedAt,
  });

  it('une date ILLISIBLE ne gagne jamais sur une vraie heure', () => {
    // `startedAt` vaut la chaîne vide quand la vue n'a pas de date, et
    // `Date.parse('')` est `NaN` : la séquence en place l'emportait, donc la
    // rouge d'avant la réparation (Reviewer C, passe 2).
    // L'illisible arrive EN PREMIER : sans la garde, elle reste en place et la
    // vraie date ne la déloge jamais.
    const gardees = lastSequenceViewPerDeliverable([
      sequence('sans-date', ''),
      sequence('datee', '2026-09-21T10:00:00.000Z'),
    ]);

    expect(gardees.map((s) => s.sequenceId)).toEqual(['datee']);
  });

  it('entre deux dates illisibles, l’ordre d’arrivée tranche', () => {
    const gardees = lastSequenceViewPerDeliverable([
      sequence('premiere', 'pas une date'),
      sequence('seconde', ''),
    ]);

    expect(gardees.map((s) => s.sequenceId)).toEqual(['seconde']);
  });

  it('sur des séquences déjà groupées, la même règle s’applique', () => {
    const gardees = lastSequenceViewPerDeliverable([
      sequence('rouge', '2026-09-21T10:00:00.000Z'),
      sequence('verte', '2026-09-21T10:05:00.000Z'),
      sequence('autre-job', '2026-09-21T10:06:00.000Z', { jobId: 'job-2' }),
    ]);

    expect(gardees.map((s) => s.sequenceId)).toEqual(['verte', 'autre-job']);
  });
});
