// ThreadScroller.test.ts — la décision « suit-on le bas du fil ? ».
//
// Le comportement complet se prouve au navigateur (spec Playwright
// `thread-autoscroll.spec.ts`) ; la DÉCISION, elle, est une fonction pure et
// s'éprouve ici. C'est elle qui porte les deux règles :
//   - un message qui arrive fait descendre le fil quand on est en bas ;
//   - il ne le fait PAS quand le lecteur a remonté l'historique, sinon
//     remonter devient impossible.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ThreadScroller, {
  staysAtBottom,
  scrollbarGutterOf,
  growthIsTheReaders,
  AT_BOTTOM_SLACK_PX,
  READER_GESTURE_WINDOW_MS,
} from '../ThreadScroller.tsx';

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

// Un bloc que le lecteur déplie s'ouvre vers le bas, sous ses yeux (Quentin,
// 18/09 : « la position du scroll ne DOIT PAS bouger »). La décision : une
// croissance qui suit de près un geste dans le fil est la sienne, pas une
// réponse qui arrive — et le fil ne la suit pas.
describe('growthIsTheReaders', () => {
  it('une croissance juste après un clic dans le fil est celle du lecteur : on ne suit pas', () => {
    expect(growthIsTheReaders({ gestureAt: 1000, now: 1016 })).toBe(true);
  });

  it('à la limite de la fenêtre, encore la sienne ; au-delà, plus', () => {
    expect(growthIsTheReaders({ gestureAt: 1000, now: 1000 + READER_GESTURE_WINDOW_MS - 1 })).toBe(
      true,
    );
    expect(growthIsTheReaders({ gestureAt: 1000, now: 1000 + READER_GESTURE_WINDOW_MS })).toBe(
      false,
    );
  });

  it('sans aucun geste, une croissance est une arrivée : on suit', () => {
    expect(growthIsTheReaders({ gestureAt: null, now: 5000 })).toBe(false);
  });

  it('un geste vieux d’une minute ne fait pas d’une réponse un dépliage', () => {
    expect(growthIsTheReaders({ gestureAt: 1000, now: 61_000 })).toBe(false);
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

// ─── La décision qui n'est PAS une fonction pure ─────────────────────────────
//
// « Une croissance du lecteur éteint le suivi » ne se lit dans aucune des
// fonctions ci-dessus : le drapeau vit dans une `ref` du composant, et il n'y
// avait rien à exporter qui vaille — une fonction qui rend `false` ne prouve
// rien. Alors le COMPOSANT est monté, avec un `ResizeObserver` qu'on tient et
// une géométrie qu'on écrit, et on regarde ce qu'il fait de `scrollTop`.
//
// Ce que ces deux cas attrapent, et que le navigateur met neuf secondes à
// montrer : un bloc plus court que `AT_BOTTOM_SLACK_PX` laissait le lecteur
// « en bas », donc le suivi allumé, et la croissance SUIVANTE — un
// rafraîchissement, 1,9 s plus tard — descendait le fil (mesuré le 18/09 sur
// /chat et sur /spaces : `scrollTop` 2459 → 2603).

/** Le `ResizeObserver` que le composant croit utiliser, et qu'on déclenche. */
function captureResizeObserver(): { fire: () => void } {
  const callbacks: Array<() => void> = [];
  class FakeResizeObserver {
    constructor(cb: () => void) {
      callbacks.push(cb);
    }
    observe(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  return {
    fire: () => {
      for (const cb of callbacks) cb();
    },
  };
}

/**
 * Une géométrie ÉCRITE sur l'élément : jsdom ne pose aucune boîte, donc
 * `scrollHeight` et consorts y valent zéro et `scrollTop` ne retient rien.
 */
function giveGeometry(
  el: HTMLElement,
  geometry: { scrollHeight: number; clientHeight: number; scrollTop: number },
): { scrollTop: () => number; setScrollHeight: (v: number) => void } {
  let scrollTop = geometry.scrollTop;
  let scrollHeight = geometry.scrollHeight;
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, 'clientHeight', {
    configurable: true,
    get: () => geometry.clientHeight,
  });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v;
    },
  });
  return {
    scrollTop: () => scrollTop,
    setScrollHeight: (v: number) => {
      scrollHeight = v;
    },
  };
}

describe('ThreadScroller — ouvrir une boîte éteint le suivi @cap:parler-a-un-agent/ecran', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    container?.remove();
    container = null;
    root = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Monte le fil, rend la zone et de quoi la piloter. */
  async function mountThread(): Promise<{
    el: HTMLElement;
    fire: () => void;
    geometry: ReturnType<typeof giveGeometry>;
  }> {
    const observer = captureResizeObserver();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(ThreadScroller, null, createElement('p', null, 'le fil')));
    });
    const el = container.querySelector<HTMLElement>('[data-thread-scroller]');
    if (!el) throw new Error('aucune zone de défilement rendue');
    // 3000 px de contenu, 800 px de fenêtre, le lecteur AU RAS DU BAS.
    const geometry = giveGeometry(el, { scrollHeight: 3000, clientHeight: 800, scrollTop: 2200 });
    // Un défilement, pour que le composant PARTE de cet état.
    //
    // Sans lui, le test ne prouvait rien : l'effet de montage écrit `scrollTop`
    // avant que cette géométrie n'existe (jsdom ne pose aucune boîte, tout y
    // vaut zéro), le composant retient donc « ma dernière position = 0 », et la
    // première croissance est lue comme un GESTE DE DÉFILEMENT du lecteur — la
    // branche d'avant celle qu'on veut éprouver. Les deux cas passaient alors
    // avec l'ancienne décision comme avec la nouvelle.
    await act(async () => {
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    return { el, fire: observer.fire, geometry };
  }

  it('un PETIT dépliage éteint le suivi : la croissance d’après ne descend plus le fil', async () => {
    const { el, fire, geometry } = await mountThread();
    const now = vi.spyOn(performance, 'now');

    // Le lecteur clique DANS le fil : c'est le geste.
    now.mockReturnValue(1_000);
    await act(async () => {
      el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });

    // Le bloc s'ouvre : 58 px, MOINS que la marge — c'est tout le cas.
    geometry.setScrollHeight(3058);
    expect(
      3058 - geometry.scrollTop() - 800,
      'le bloc doit être plus court que la marge, sinon ce cas ne prouve rien',
    ).toBeLessThan(AT_BOTTOM_SLACK_PX);
    now.mockReturnValue(1_100);
    await act(async () => fire());
    expect(geometry.scrollTop(), 'le dépliage a déplacé le lecteur').toBe(2200);

    // 1,9 s plus tard : une arrivée ordinaire, hors de la fenêtre du geste.
    geometry.setScrollHeight(3400);
    now.mockReturnValue(1_000 + READER_GESTURE_WINDOW_MS + 1_100);
    await act(async () => fire());

    expect(
      geometry.scrollTop(),
      'le fil a suivi une arrivée alors que le lecteur venait d’ouvrir une boîte',
    ).toBe(2200);
  });

  it('…et il se rallume quand le lecteur redescend jusqu’en bas', async () => {
    const { el, fire, geometry } = await mountThread();
    const now = vi.spyOn(performance, 'now');

    now.mockReturnValue(1_000);
    await act(async () => {
      el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    geometry.setScrollHeight(3058);
    now.mockReturnValue(1_100);
    await act(async () => fire());
    expect(geometry.scrollTop()).toBe(2200);

    // Le lecteur redescend au ras du bas : `onScroll` rallume le suivi.
    el.scrollTop = 3058 - 800;
    await act(async () => {
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    // L'arrivée suivante le suit de nouveau.
    geometry.setScrollHeight(3400);
    now.mockReturnValue(1_000 + READER_GESTURE_WINDOW_MS + 1_100);
    await act(async () => fire());

    expect(geometry.scrollTop(), 'revenu en bas, le lecteur devrait être suivi de nouveau').toBe(
      3400,
    );
  });

  it('le lecteur qui redescend ENTRE deux croissances d’un même dépliage reste suivi', async () => {
    // Un dépliage arrive souvent en DEUX temps : le bloc, puis son corps
    // quelques dizaines de millisecondes plus tard (mesuré : t=0 ms, t=46 ms).
    // Si le lecteur descend en bas entre les deux, la SECONDE croissance est
    // encore dans la fenêtre du geste — et sans clôture du geste elle
    // ré-éteignait le suivi qu'il venait de rallumer, sans que rien ne le
    // rallume ensuite. Attrapé par le cas B de `thread-unfold-keeps-scroll`.
    const { el, fire, geometry } = await mountThread();
    const now = vi.spyOn(performance, 'now');

    now.mockReturnValue(1_000);
    await act(async () => {
      el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });

    // Premier temps du dépliage.
    geometry.setScrollHeight(3400);
    now.mockReturnValue(1_050);
    await act(async () => fire());

    // Le lecteur descend jusqu'en bas, DANS la fenêtre du geste.
    el.scrollTop = 3400 - 800;
    now.mockReturnValue(1_100);
    await act(async () => {
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    // Second temps du dépliage, toujours dans la fenêtre.
    geometry.setScrollHeight(3600);
    now.mockReturnValue(1_150);
    await act(async () => fire());

    // Et l'arrivée suivante, bien après : elle doit le suivre.
    geometry.setScrollHeight(4000);
    now.mockReturnValue(1_000 + READER_GESTURE_WINDOW_MS + 1_000);
    await act(async () => fire());

    expect(
      geometry.scrollTop(),
      'le lecteur était en bas et n’a pas été suivi : la queue du dépliage a éteint le suivi',
    ).toBe(4000);
  });
});
