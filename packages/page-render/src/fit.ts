// fit.ts — tenir le nombre de pages demandé, en UN appel (#1082).
//
// Le constat qui l'a fait naître (16/11/2026, l'installation du propriétaire) :
// une demande a rendu le même fichier 6 fois en 108 secondes. La page devait
// tenir sur une page ; l'agent ne pouvait pas le savoir avant de rendre ; il
// rendait, comptait les pages, coupait du texte, réduisait la photo, rendait
// encore. La décision du propriétaire : « l'agent dit à l'outil "sur 1 page"
// (ou 2, ou 4) ; l'outil ajuste lui-même la taille au rendu, et son résultat
// dit combien de pages il a faites et à quelle taille ». L'agent ne réécrit
// pas le texte de la personne pour qu'il tienne.
//
// LA RECHERCHE. Le nombre de pages est compté sur le PDF réellement produit,
// jamais estimé (la mise en page de Chrome, ses sauts de page, ses polices ne
// se prédisent pas). L'échelle se cherche par dichotomie, au centième, entre
// l'échelle minimale lisible (qui doit tenir, sinon l'appel échoue fort) et 1
// (qui ne tient pas, sinon on s'arrête là) :
//   1. rendu à l'échelle 1 : s'il tient, c'est le résultat — une page déjà
//      plus courte n'est jamais agrandie ;
//   2. rendu à l'échelle minimale : s'il ne tient pas, l'appel échoue en
//      disant combien de pages il fait là ;
//   3. entre les deux, la plus GRANDE échelle qui tient.
// Environ huit rendus au pire, dans le même navigateur, en quelques secondes.

/** Un rendu à une échelle : le PDF produit et ses pages comptées. */
export interface ScaledRender {
  scale: number;
  pages: number;
  pdf: Uint8Array;
}

export type FitOutcome =
  | { ok: true; best: ScaledRender; atFullScale: ScaledRender; renders: number }
  | { ok: false; atMinScale: ScaledRender; atFullScale: ScaledRender; renders: number };

/** L'échelle au centième, pour que la recherche s'arrête et que le résultat se lise. */
const cents = (scale: number): number => Math.round(scale * 100);

/**
 * La plus grande échelle de [minScale, 1] dont le rendu tient en `maxPages`
 * pages. `renderAt` rend et compte ; il est appelé avec des échelles au
 * centième.
 */
export async function fitToPages(
  maxPages: number,
  minScale: number,
  renderAt: (scale: number) => Promise<ScaledRender>,
): Promise<FitOutcome> {
  let renders = 0;
  const render = async (c: number): Promise<ScaledRender> => {
    renders += 1;
    return renderAt(c / 100);
  };
  const full = await render(100);
  if (full.pages <= maxPages) return { ok: true, best: full, atFullScale: full, renders };
  let lo = cents(minScale);
  const atMin = await render(lo);
  if (atMin.pages > maxPages) return { ok: false, atMinScale: atMin, atFullScale: full, renders };
  let best = atMin;
  let hi = 100;
  // Invariant : `lo` tient, `hi` ne tient pas.
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const r = await render(mid);
    if (r.pages <= maxPages) {
      lo = mid;
      best = r;
    } else {
      hi = mid;
    }
  }
  return { ok: true, best, atFullScale: full, renders };
}
