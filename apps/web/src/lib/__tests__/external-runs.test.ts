// external-runs.test.ts — les deux règles de la liste du dossier MCP (#183) :
// où reprendre, et ce qu'on a le droit de supprimer.
//
// Pures toutes les deux, donc prouvables sans base ni navigateur. Ce que la
// base en fait est prouvé à côté (`external-runs-pages.test.ts`).
//
// Mutations vérifiées : le cas `SANS_DATE` retiré de `decodeRunCursor` → « sait
// désigner une ligne sans date » rougit ; `runIsDeletable` rendant `true` sur
// un statut absent → « un statut absent compte comme vivant » rougit.

import { describe, it, expect } from 'vitest';
import { decodeRunCursor, encodeRunCursor, runIsDeletable } from '../external-runs.ts';

describe('le curseur de la liste des runs @cap:parler-par-canal-externe/moteur', () => {
  it('désigne une LIGNE — sa date et son identifiant, pas un rang', () => {
    const quand = new Date('2026-09-18T09:05:00.000Z');
    const curseur = encodeRunCursor({ createdAt: quand, id: 'abc' });
    expect(curseur).toBe('2026-09-18T09:05:00.000Z|abc');
    expect(decodeRunCursor(curseur)).toEqual({ createdAt: quand, id: 'abc' });
  });

  it('sait désigner une ligne SANS date, celles que l’ordre range en dernier', () => {
    const curseur = encodeRunCursor({ createdAt: null, id: 'abc' });
    expect(decodeRunCursor(curseur)).toEqual({ createdAt: null, id: 'abc' });
  });

  it('refait le tour sans rien perdre, sur un identifiant qui contient des tirets', () => {
    const ligne = {
      createdAt: new Date('2026-01-02T03:04:05.678Z'),
      id: '11111111-2222-3333-4444-555555555555',
    };
    expect(decodeRunCursor(encodeRunCursor(ligne))).toEqual(ligne);
  });

  it('rend `null` — donc « repars du début » — pour ce qui ne désigne rien', () => {
    // Un curseur illisible ne doit pas rendre une page vide : une liste qui
    // disparaît sans rien dire serait pire que la première page.
    expect(decodeRunCursor(null)).toBeNull();
    expect(decodeRunCursor(undefined)).toBeNull();
    expect(decodeRunCursor('')).toBeNull();
    expect(decodeRunCursor('nimportequoi')).toBeNull();
    expect(decodeRunCursor('|abc')).toBeNull();
    expect(decodeRunCursor('2026-09-18T09:05:00.000Z|')).toBeNull();
    expect(decodeRunCursor('pas-une-date|abc')).toBeNull();
  });
});

describe('ce qu’un run laisse supprimer @cap:parler-par-canal-externe/moteur', () => {
  it('laisse supprimer un run TERMINÉ, quelle qu’en soit l’issue', () => {
    expect(runIsDeletable('completed')).toBe(true);
    expect(runIsDeletable('failed')).toBe(true);
    expect(runIsDeletable('cancelled')).toBe(true);
  });

  it('refuse un run qui avance encore', () => {
    expect(runIsDeletable('pending')).toBe(false);
    expect(runIsDeletable('processing')).toBe(false);
    expect(runIsDeletable('awaiting_delegation')).toBe(false);
  });

  it('refuse AUSSI un run arrêté sur une demande', () => {
    // Il n'allume pas le point vert, mais il n'a pas fini : le supprimer
    // emporterait la demande en attente avec lui, en silence.
    expect(runIsDeletable('awaiting_approval')).toBe(false);
  });

  it('compte un statut ABSENT comme vivant', () => {
    // Une ligne qui vient de naître n'a pas encore de statut. La lire comme
    // « terminée » serait un repli silencieux (invariant #4).
    expect(runIsDeletable(null)).toBe(false);
  });
});
