// navigation-trail.test.ts — le fil des pages visitées, et la décision que
// « Back » en tire (#232).
//
// Ce qui est prouvé ici est la RÈGLE elle-même, hors navigateur : quelle page
// « Back » demande. Le constat du 19/09 était qu'une page de détail, atteinte
// par deux chemins, repartait toujours au même endroit — donc au mauvais pour
// l'un des deux. Les assertions portent sur le CHEMIN rendu, jamais sur un
// compte d'appels.

import { describe, it, expect } from 'vitest';
import {
  backTarget,
  isAppPath,
  parseTrail,
  recordVisit,
  serializeTrail,
  TRAIL_MAX,
  type TrailEntry,
} from '../navigation-trail.ts';

/** Le fil tel qu'il serait après ces visites, dans l'ordre. */
function visits(paths: readonly string[]): TrailEntry[] {
  let trail: TrailEntry[] = [];
  for (const p of paths) trail = recordVisit(trail, p, null).trail;
  return trail;
}

describe('navigation-trail — ce que le fil retient @cap:suivre-execution/ecran', () => {
  it('enregistre chaque page de l’app visitée, dans l’ordre', () => {
    expect(visits(['/spaces/ws-1', '/chat/c-9']).map((e) => e.path)).toEqual([
      '/spaces/ws-1',
      '/chat/c-9',
    ]);
  });

  it('ne garde PAS une page hors de l’app — /login et /onboarding n’y entrent pas', () => {
    expect(visits(['/login', '/scheduled/run-1']).map((e) => e.path)).toEqual(['/scheduled/run-1']);
    expect(visits(['/onboarding', '/agents']).map((e) => e.path)).toEqual(['/agents']);
    expect(isAppPath('/login')).toBe(false);
    expect(isAppPath('/onboarding/step-2')).toBe(false);
    expect(isAppPath('/scheduled/run-1')).toBe(true);
  });

  // ── Les chemins qui MENTENT sur leur destination (revue #234, passe 1) ────
  //
  // Chacun commence par un seul `/`, donc chacun passait la garde du double
  // slash. Un cas par forme, à l'ÉCRITURE et à la LECTURE : c'est la lecture
  // qui compte contre une entrée glissée à la main dans `sessionStorage`.

  it('refuse un chemin à ANTISLASH — le navigateur en refait un double slash', () => {
    const menteur = '/\\evil.example.com';
    expect(isAppPath(menteur)).toBe(false);
    expect(visits([menteur, '/agents']).map((e) => e.path)).toEqual(['/agents']);
    expect(parseTrail(JSON.stringify([{ path: menteur, key: 0 }]))).toEqual([]);
    // Un antislash au milieu ment tout autant.
    expect(isAppPath('/chat/..\\..\\evil')).toBe(false);
  });

  it('refuse un slash ENCODÉ — %2F et %5C redeviennent des séparateurs', () => {
    expect(isAppPath('/%2Fevil.example.com')).toBe(false);
    expect(isAppPath('/%5Cevil.example.com')).toBe(false);
    expect(isAppPath('/chat/%2f%2fevil')).toBe(false);
    expect(visits(['/%2Fevil.example.com', '/agents']).map((e) => e.path)).toEqual(['/agents']);
    expect(parseTrail(JSON.stringify([{ path: '/%5Cevil', key: 0 }]))).toEqual([]);
  });

  it('refuse un caractère de CONTRÔLE — l’analyse d’URL le retire avant de lire le chemin', () => {
    const nul = '/\x00/evil.example.com';
    const retour = '/chat/c-9\n/evil';
    for (const menteur of [nul, retour, '/\t/evil.example.com', '/chat/\x7f']) {
      expect(isAppPath(menteur)).toBe(false);
    }
    expect(visits([nul, '/agents']).map((e) => e.path)).toEqual(['/agents']);
    expect(parseTrail(JSON.stringify([{ path: retour, key: 0 }]))).toEqual([]);
  });

  it('les vrais chemins de l’app passent encore — le filtre ne mord pas dedans', () => {
    for (const bon of [
      '/agents',
      '/chat/c-9',
      '/spaces/ws-1/files',
      '/jobs/codex-42',
      '/scheduled/run-7',
      '/settings/root-context',
    ]) {
      expect(isAppPath(bon)).toBe(true);
    }
  });

  it('ne garde PAS une adresse qui sort du site, même écrite à la main dans le stockage', () => {
    // `sessionStorage` s'édite : sans ce filtre, « Back » emmènerait ailleurs.
    const raw = JSON.stringify([
      { path: '//evil.example.com', key: 0 },
      { path: 'https://evil.example.com/x', key: 1 },
      { path: '/agents', key: 2 },
    ]);
    expect(parseTrail(raw).map((e) => e.path)).toEqual(['/agents']);
    expect(isAppPath('//evil.example.com')).toBe(false);
    expect(isAppPath('https://evil.example.com/x')).toBe(false);
  });

  it('un re-rendu sur le même chemin n’ajoute rien — sinon « Back » ne bougerait plus', () => {
    const trail = visits(['/spaces/ws-1', '/chat/c-9', '/chat/c-9']);
    expect(trail.map((e) => e.path)).toEqual(['/spaces/ws-1', '/chat/c-9']);
  });

  it('revenir par le bouton du navigateur TRONQUE le fil au lieu de l’allonger', () => {
    // L'entrée d'historique porte déjà sa clé : on y est REVENU. Allonger le
    // fil ferait croire qu'on vient de `/chat/c-9`, alors que l'historique est
    // déjà repassé avant — et « Back » sauterait hors de l'app.
    const trail = visits(['/spaces/ws-1', '/chat/c-9']);
    const back = recordVisit(trail, '/spaces/ws-1', 0);
    expect(back.trail.map((e) => e.path)).toEqual(['/spaces/ws-1']);
    expect(back.key).toBeNull();
  });

  it('le fil est borné : au-delà, les plus vieilles pages tombent', () => {
    const many = Array.from({ length: TRAIL_MAX + 3 }, (_, i) => `/chat/c-${i}`);
    const trail = visits(many);
    expect(trail).toHaveLength(TRAIL_MAX);
    expect(trail[trail.length - 1]?.path).toBe(`/chat/c-${TRAIL_MAX + 2}`);
  });

  it('un stockage illisible ne casse rien — le fil repart vide', () => {
    expect(parseTrail('pas du json')).toEqual([]);
    expect(parseTrail(null)).toEqual([]);
    expect(parseTrail('{"path":"/agents"}')).toEqual([]);
    expect(parseTrail(serializeTrail(visits(['/agents'])))).toEqual([{ path: '/agents', key: 0 }]);
  });
});

describe('navigation-trail — où « Back » demande à aller @cap:suivre-execution/ecran', () => {
  it('fil présent : la page précédente, pas le parent', () => {
    // Le cas du 19/09 : un workspace, puis une de ses conversations.
    const trail = visits(['/spaces/ws-1', '/chat/c-9']);
    const target = backTarget(trail, '/chat/c-9');
    // Les deux pages se suivent dans l'historique : on dépile vraiment, ce qui
    // rend la position de défilement et ne gonfle pas l'historique.
    expect(target).toEqual({ mode: 'back' });
  });

  it('fil présent mais entrée d’historique NON adjacente : on y va par l’avant, par son chemin', () => {
    const trail: TrailEntry[] = [
      { path: '/spaces/ws-1', key: 0 },
      { path: '/chat/c-9', key: 4 },
    ];
    expect(backTarget(trail, '/chat/c-9')).toEqual({ mode: 'push', path: '/spaces/ws-1' });
  });

  it('fil vide : rien à proposer, l’appelant prendra le parent', () => {
    expect(backTarget([], '/scheduled/run-1')).toBeNull();
  });

  it('première page de l’onglet : rien non plus — un lien collé dans un nouvel onglet', () => {
    expect(backTarget(visits(['/scheduled/run-1']), '/scheduled/run-1')).toBeNull();
  });

  it('le même écran atteint par deux chemins repart à deux endroits', () => {
    // C'est TOUTE l'issue : `/jobs/j-1` ouvert depuis Activity, puis depuis
    // une automation. Le parent codé en dur donnait la même réponse aux deux.
    const parActivity: TrailEntry[] = [
      { path: '/logs', key: 0 },
      { path: '/jobs/j-1', key: 7 },
    ];
    const parAutomation: TrailEntry[] = [
      { path: '/automations', key: 0 },
      { path: '/jobs/j-1', key: 7 },
    ];
    expect(backTarget(parActivity, '/jobs/j-1')).toEqual({ mode: 'push', path: '/logs' });
    expect(backTarget(parAutomation, '/jobs/j-1')).toEqual({ mode: 'push', path: '/automations' });
  });

  it('une page hors de l’app glissée dans le fil ne devient jamais une destination', () => {
    const trail: TrailEntry[] = [
      { path: '//evil.example.com', key: 0 },
      { path: '/chat/c-9', key: 1 },
    ];
    expect(backTarget(trail, '/chat/c-9')).toBeNull();
  });
});
