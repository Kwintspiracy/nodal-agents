// ThreadScroller.test.ts — la décision « suit-on le bas du fil ? ».
//
// Le comportement complet se prouve au navigateur (spec Playwright
// `thread-autoscroll.spec.ts`) ; la DÉCISION, elle, est une fonction pure et
// s'éprouve ici. C'est elle qui porte les deux règles :
//   - un message qui arrive fait descendre le fil quand on est en bas ;
//   - il ne le fait PAS quand le lecteur a remonté l'historique, sinon
//     remonter devient impossible.

import { describe, it, expect } from 'vitest';
import { staysAtBottom, scrollbarGutterOf, AT_BOTTOM_SLACK_PX } from '../ThreadScroller.tsx';

/** Un fil de 3000 px dans une fenêtre de 800 px : 2200 px de course. */
const FIL = { scrollHeight: 3000, clientHeight: 800 };

describe('staysAtBottom', () => {
  it('au ras du bas : on suit', () => {
    expect(staysAtBottom({ ...FIL, scrollTop: 2200 })).toBe(true);
  });

  it('à quelques pixels du bas : on suit encore', () => {
    // Un défilement à la molette s'arrête rarement au pixel près.
    expect(staysAtBottom({ ...FIL, scrollTop: 2200 - (AT_BOTTOM_SLACK_PX - 1) })).toBe(true);
  });

  it('juste au-delà de la marge : on ne suit plus', () => {
    expect(staysAtBottom({ ...FIL, scrollTop: 2200 - AT_BOTTOM_SLACK_PX })).toBe(false);
  });

  it('remonté de 500 px dans l’historique : on ne suit pas', () => {
    // Le cas qui compte : sans lui, le rafraîchissement suivant ramènerait le
    // lecteur en bas et relire une réponse deviendrait impossible.
    expect(staysAtBottom({ ...FIL, scrollTop: 1700 })).toBe(false);
  });

  it('tout en haut : on ne suit pas', () => {
    expect(staysAtBottom({ ...FIL, scrollTop: 0 })).toBe(false);
  });

  it('un fil plus court que la fenêtre : on suit (il n’y a pas de « haut » où remonter)', () => {
    expect(staysAtBottom({ scrollHeight: 400, clientHeight: 800, scrollTop: 0 })).toBe(true);
  });
});

// La gouttière que la saisie doit se réserver pour tomber sur le fil (Quentin,
// 17/09 : la saisie était décalée d'une demi-barre vers la droite).
describe('scrollbarGutterOf', () => {
  it('une barre classique de 17 px prend 17 px', () => {
    expect(scrollbarGutterOf({ offsetWidth: 1200, clientWidth: 1183 })).toBe(17);
  });

  it('une barre qui se superpose au contenu ne prend rien', () => {
    expect(scrollbarGutterOf({ offsetWidth: 1200, clientWidth: 1200 })).toBe(0);
  });

  it('jamais négatif, quoi que le navigateur mesure', () => {
    expect(scrollbarGutterOf({ offsetWidth: 0, clientWidth: 12 })).toBe(0);
  });
});
