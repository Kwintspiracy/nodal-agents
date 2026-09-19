// Switch.test.tsx — un seul interrupteur, un seul look (#236).
//
// Pourquoi ce fichier existe : le 19/09/2026 Quentin a vu le toggle du serveur
// MCP « avoir l'air désactivé alors qu'il est allumé ». Le composant ne portait
// que la géométrie ; chaque appelant peignait sa piste et son bouton, et le
// langage teinté (`bg-agent/20` + bouton coloré) se lit comme un contrôle
// éteint à côté du langage plein. Le composant porte maintenant l'apparence,
// et ce fichier dit CE QU'IL REND, pas qu'on l'a appelé.
//
// Les faits vérifiés, tirés de la planche Figma `Switch` (node 108:18) :
//   1. allumé = piste `bg-ok`, bouton à droite ; éteint = piste `bg-ink-4`,
//      bouton à gauche. Les deux états ne partagent aucune classe de couleur.
//   2. allumé ET éteint rendent une piste PLEINE — aucune teinte `/20`, aucune
//      opacité : c'est exactement ce qui faisait lire « désactivé ».
//   3. `disabled` est le seul état atténué (`disabled:opacity-50`), et il porte
//      l'attribut HTML, donc le clic ne passe pas.
//   4. `aria-checked` suit `checked`, et l'aria de l'appelant arrive au bouton.
//   5. le clavier marche sans code : c'est un vrai <button>, donc Entrée et
//      Espace déclenchent `onChange` via l'activation native.
//   6. les deux tailles de la planche rendent leurs géométries, et rien d'autre.
//
// Mutations vérifiées (chacune appliquée à Switch.tsx, le test devant rougir) :
//   - piste allumée repassée à `bg-agent/20` → le cas « allumé » rougit sur la
//     piste pleine ET sur le fait que les deux états ne partagent rien ;
//   - `disabled:opacity-50` retiré → le cas « seul Disabled est atténué »
//     rougit ;
//   - `translate-x-[19px]` remis à `translate-x-[3px]` → la position du bouton
//     rougit dans les deux tailles.

import { describe, it, expect, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import Switch from '../Switch.tsx';

/** Les classes du <button> (la piste), en liste — pour dire « celle-ci et pas
 *  celle-là » sans qu'un `bg-ok` trouvé dans `bg-ok-bg` fasse illusion. */
function classesPiste(html: string): string[] {
  const m = /<button[^>]*class="([^"]*)"/.exec(html);
  if (!m) throw new Error('aucun <button role="switch"> rendu');
  return m[1]!.split(/\s+/);
}

/** Les classes du <span> intérieur (le bouton qui glisse). */
function classesBouton(html: string): string[] {
  const m = /<span[^>]*class="([^"]*)"/.exec(html);
  if (!m) throw new Error('aucun bouton rendu');
  return m[1]!.split(/\s+/);
}

function rendu(props: Partial<Parameters<typeof Switch>[0]> & { checked: boolean }): string {
  return renderToStaticMarkup(<Switch onChange={() => {}} {...props} />);
}

describe('Switch — un seul look, sans ambiguïté @cap:regler-autonomie/ecran', () => {
  it('allumé rend une piste pleine bg-ok et le bouton à droite', () => {
    const html = rendu({ checked: true });
    expect(classesPiste(html)).toContain('bg-ok');
    expect(classesBouton(html)).toContain('translate-x-[19px]');
    expect(classesBouton(html)).toContain('bg-paper');
  });

  it('éteint rend une piste pleine bg-ink-4 et le bouton à gauche', () => {
    const html = rendu({ checked: false });
    expect(classesPiste(html)).toContain('bg-ink-4');
    expect(classesBouton(html)).toContain('translate-x-[3px]');
    expect(classesBouton(html)).toContain('bg-paper');
  });

  it('les deux états ne partagent aucune couleur de piste', () => {
    const allume = classesPiste(rendu({ checked: true })).filter((c) => c.startsWith('bg-'));
    const eteint = classesPiste(rendu({ checked: false })).filter((c) => c.startsWith('bg-'));
    expect(allume).toEqual(['bg-ok']);
    expect(eteint).toEqual(['bg-ink-4']);
    expect(allume.some((c) => eteint.includes(c))).toBe(false);
  });

  it("aucun état actif n'est teinté ni atténué — c'est ce qui se lisait « désactivé »", () => {
    for (const checked of [true, false]) {
      const piste = classesPiste(rendu({ checked }));
      // Une teinte, c'est un `/<nombre>` sur la couleur de fond, et une
      // atténuation une opacité inconditionnelle : ni l'une ni l'autre ici.
      expect(piste.filter((c) => /^bg-.+\/\d/.test(c))).toEqual([]);
      expect(piste.filter((c) => /^opacity-/.test(c))).toEqual([]);
    }
  });

  it('disabled est le SEUL état atténué, et il porte vraiment l’attribut', () => {
    const actif = rendu({ checked: true });
    const inactif = rendu({ checked: true, disabled: true });
    expect(classesPiste(inactif)).toContain('disabled:opacity-50');
    expect(inactif).toContain('disabled=""');
    expect(actif).not.toContain('disabled=""');
    // La couleur ne change pas : c'est l'opacité qui dit « désactivé ».
    expect(classesPiste(inactif)).toContain('bg-ok');
  });

  it('aria-checked suit checked, et l’aria de l’appelant arrive au bouton', () => {
    expect(rendu({ checked: true })).toContain('aria-checked="true"');
    expect(rendu({ checked: false })).toContain('aria-checked="false"');
    const html = rendu({ checked: false, ariaLabel: 'Enable the MCP server' });
    expect(html).toContain('aria-label="Enable the MCP server"');
    expect(html).toContain('role="switch"');
    const lie = rendu({ checked: false, ariaLabelledBy: 'lbl', ariaDescribedBy: 'desc' });
    expect(lie).toContain('aria-labelledby="lbl"');
    expect(lie).toContain('aria-describedby="desc"');
  });

  it('chaque taille rend sa géométrie, et pas celle de l’autre', () => {
    const sm = rendu({ checked: false, size: 'sm' });
    const md = rendu({ checked: false, size: 'md' });
    expect(classesPiste(sm)).toEqual(expect.arrayContaining(['h-5', 'w-9']));
    expect(classesPiste(sm)).not.toContain('h-[22px]');
    expect(classesBouton(sm)).toEqual(expect.arrayContaining(['h-3.5', 'w-3.5']));
    expect(classesPiste(md)).toEqual(expect.arrayContaining(['h-[22px]', 'w-[38px]']));
    expect(classesPiste(md)).not.toContain('h-5');
    expect(classesBouton(md)).toEqual(expect.arrayContaining(['h-4', 'w-4']));
    // Le bouton parcourt la même distance dans les deux tailles (3px → 19px).
    expect(classesBouton(rendu({ checked: true, size: 'sm' }))).toContain('translate-x-[19px]');
    expect(classesBouton(rendu({ checked: true, size: 'md' }))).toContain('translate-x-[19px]');
  });

  it('le focus se voit par un anneau, pas par un changement de piste', () => {
    const piste = classesPiste(rendu({ checked: false }));
    expect(piste).toContain('focus-visible:ring-[3px]');
    expect(piste).toContain('focus-visible:ring-conn-vivid/50');
    expect(piste).toContain('focus-visible:outline-none');
  });
});

describe('Switch — ce que fait le contrôle @cap:regler-autonomie/ecran', () => {
  async function monter(node: React.ReactElement): Promise<{ root: Root; el: HTMLButtonElement }> {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(node);
    });
    const el = container.querySelector<HTMLButtonElement>('button[role="switch"]');
    if (!el) throw new Error('aucun interrupteur rendu');
    return { root, el };
  }

  it('un clic appelle onChange une fois', async () => {
    const onChange = vi.fn();
    const { el } = await monter(<Switch checked={false} onChange={onChange} ariaLabel="Yolo" />);
    await act(async () => {
      el.click();
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('désactivé, le clic ne déclenche rien', async () => {
    const onChange = vi.fn();
    const { el } = await monter(<Switch checked disabled onChange={onChange} ariaLabel="Yolo" />);
    await act(async () => {
      el.click();
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('le clavier marche parce que c’est un vrai <button>, pas un div', async () => {
    const onChange = vi.fn();
    const { el } = await monter(<Switch checked={false} onChange={onChange} ariaLabel="Yolo" />);
    expect(el.tagName).toBe('BUTTON');
    // jsdom n'implémente pas l'activation clavier native ; ce que le test peut
    // prouver, c'est que l'élément est de ceux que le navigateur active à
    // Entrée et à Espace, qu'il est focalisable et qu'il ne se soumet pas.
    expect(el.getAttribute('type')).toBe('button');
    el.focus();
    expect(document.activeElement).toBe(el);
  });
});
