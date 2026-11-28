// fit.test.ts — la recherche de l'échelle, sans navigateur (#1082).
//
// `renderAt` est ici une mise en page FAUSSE mais honnête : une hauteur de
// contenu qui rétrécit avec l'échelle, découpée en pages d'une hauteur fixe.
// Le test réel, sur des PDF produits par le moteur, est render.test.ts.

import { describe, it, expect } from 'vitest';
import { fitToPages, type ScaledRender } from '../fit';

/** Un contenu de `height` unités sur des pages de `page` unités. */
function layout(height: number, page = 1000) {
  const asked: number[] = [];
  const renderAt = async (scale: number): Promise<ScaledRender> => {
    asked.push(scale);
    return { scale, pages: Math.max(1, Math.ceil((height * scale) / page)), pdf: new Uint8Array() };
  };
  return { renderAt, asked };
}

describe('fitToPages @cap:travailler-sur-des-fichiers/moteur', () => {
  it('a page that already fits is rendered once, at scale 1, never enlarged', async () => {
    const l = layout(400);
    const out = await fitToPages(1, 0.6, l.renderAt);
    expect(out.ok && out.best.scale).toBe(1);
    expect(l.asked).toEqual([1]);
  });

  it('1.3 pages asked on 1: the largest scale at the hundredth that fits', async () => {
    const l = layout(1300);
    const out = await fitToPages(1, 0.6, l.renderAt);
    if (!out.ok) throw new Error('expected a fit');
    // 1300 × 0.76 = 988 fits, 1300 × 0.77 = 1001 does not.
    expect(out.best.scale).toBe(0.76);
    expect(out.best.pages).toBe(1);
    expect(out.atFullScale.pages).toBe(2);
    // Scale 1, the minimum, then a bisection between them: a bounded count.
    expect(out.renders).toBe(l.asked.length);
    expect(out.renders).toBeLessThanOrEqual(9);
  });

  it('the same page asked on 2: scale 1', async () => {
    const out = await fitToPages(2, 0.6, layout(1300).renderAt);
    expect(out.ok && out.best.scale).toBe(1);
    expect(out.ok && out.best.pages).toBe(2);
  });

  it('a page too long even at the minimum scale fails, with the pages it takes there', async () => {
    const out = await fitToPages(1, 0.6, layout(4000).renderAt);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.atMinScale).toMatchObject({ scale: 0.6, pages: 3 });
    expect(out.atFullScale.pages).toBe(4);
  });

  it('a page that fits exactly at the minimum scale is rendered there', async () => {
    const out = await fitToPages(1, 0.6, layout(1666).renderAt);
    expect(out.ok && out.best.scale).toBe(0.6);
  });

  it('holds 4 pages as well as 1', async () => {
    const out = await fitToPages(4, 0.6, layout(5000).renderAt);
    if (!out.ok) throw new Error('expected a fit');
    expect(out.best.pages).toBe(4);
    expect(out.best.scale).toBe(0.8);
  });
});
