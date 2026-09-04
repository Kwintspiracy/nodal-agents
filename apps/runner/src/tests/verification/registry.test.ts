// registry.test.ts — le registre des vérificateurs : ce qu'il refuse, et la
// clé qu'il produit.
//
// Ce qui est prouvé ici : un type de livrable sans vérificateur est REFUSÉ
// (jamais accepté avec une clé inventée), et la clé canonique d'un projet de
// code est EXACTEMENT celle de `@nodal-agents/shared` — pas une deuxième règle
// de casse qui divergerait au premier chemin UNC.

import { describe, it, expect } from 'vitest';
import { projectKey } from '@nodal-agents/shared';
import {
  DELIVERABLE_TYPE_UNSUPPORTED,
  DeliverableTypeUnsupportedError,
  canonicalKeyFor,
  getVerifier,
  registeredDeliverableTypes,
} from '../../verification/registry.ts';

describe('registre — un type sans vérificateur est refusé', () => {
  it('getVerifier d’un type réservé lève DELIVERABLE_TYPE_UNSUPPORTED', () => {
    let caught: unknown = null;
    try {
      getVerifier('office_file');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DeliverableTypeUnsupportedError);
    expect((caught as DeliverableTypeUnsupportedError).code).toBe(DELIVERABLE_TYPE_UNSUPPORTED);
    expect((caught as DeliverableTypeUnsupportedError).deliverableType).toBe('office_file');
  });

  it('canonicalKeyFor refuse aussi — aucune clé n’est inventée pour un type inconnu', () => {
    expect(() => canonicalKeyFor('document', '/srv/App')).toThrow(DELIVERABLE_TYPE_UNSUPPORTED);
    expect(() => canonicalKeyFor('outbound_action', 'telegram:42')).toThrow(
      DELIVERABLE_TYPE_UNSUPPORTED,
    );
    expect(() => canonicalKeyFor('inconnu', '/srv/App')).toThrow(DELIVERABLE_TYPE_UNSUPPORTED);
  });

  it('un seul type est branché en PR① — le registre s’indexe sur le vérificateur, pas sur une liste recopiée', () => {
    expect(registeredDeliverableTypes()).toEqual(['code_project']);
    expect(getVerifier('code_project').deliverableType).toBe('code_project');
  });
});

describe('registre — la clé canonique d’un projet de code', () => {
  // Le corpus du ticket : les deux formes Windows (lettre de lecteur et
  // partage UNC) se replient en casse, un chemin POSIX NON — `/srv/App` et
  // `/srv/app` sont deux dossiers différents sur un système sensible à la casse.
  const corpus = [
    'D:\\Dev\\App\\',
    'd:/dev/app',
    '//srv/part/App',
    '\\\\srv\\part\\app',
    '/srv/App',
    '/srv/app',
  ];

  it('canonicalize rend exactement projectKey de @nodal-agents/shared', () => {
    const verifier = getVerifier('code_project');
    for (const raw of corpus) {
      expect(verifier.canonicalize(raw)).toBe(projectKey(raw));
      expect(canonicalKeyFor('code_project', raw)).toBe(projectKey(raw));
    }
  });

  it('Windows et UNC se replient, POSIX ne se replie pas', () => {
    const key = (raw: string): string => canonicalKeyFor('code_project', raw);
    expect(key('D:\\Dev\\App\\')).toBe(key('d:/dev/app'));
    expect(key('//srv/part/App')).toBe(key('\\\\srv\\part\\app'));
    expect(key('/srv/App')).not.toBe(key('/srv/app'));
  });
});
