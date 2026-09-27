// Table.test.tsx — ce que les cellules partagées RENDENT (#522).
//
// Avant #522, `Table` donnait le cadre et rien de ce qui va dans une cellule :
// chaque table rebâtissait la sienne, et les nombres étaient `font-mono
// text-xs text-ink-3` dans Logs, `text-mono-12 text-ink-4` dans Runs. Ce
// fichier dit, sur le DOM rendu, la recette de chaque sorte de cellule, pour
// qu'un changement de recette soit un changement voulu et vu, jamais une dérive.
//
// Les faits :
//   1. chaque cellule porte SA recette de la rampe typographique, et aucune
//      classe brute (`text-xs`, `text-sm`, `font-mono`, `text-legacy-*`,
//      taille fractionnaire `text-[…]`) ;
//   2. un agent se rend partout pareil (avatar rond md + nom medium-13), et un
//      agent inconnu se dit « Unknown » sans avatar inventé ;
//   3. la ligne dépliée porte un en-tête à la recette EXACTE de <Th>, et rien
//      quand elle n'a ni libellé ni action ;
//   4. la pagination garde ses deux boutons ; celui qui ne mène nulle part est
//      désactivé, pas absent ;
//   5. une ligne dépliée le dit (`aria-expanded`) et se teinte ; une ligne qui
//      ne se déplie pas ne porte pas l'attribut du tout ;
//   6. une ligne `top` aligne ses cellules en haut, et le visuel en tête d'une
//      pile de plusieurs lignes suit sa ligne ; une seule ligne reste centrée.
//
// Mutations vérifiées (appliquées à Table.tsx, le test devant rougir) :
//   - CellMono remise à `font-mono text-xs text-ink-3` → les faits 1 rougissent ;
//   - l'en-tête de TableDetailRow remis à `text-legacy-10 uppercase
//     tracking-wider text-ink-3` → le fait 3 rougit ;
//   - le bouton Previous rendu seulement quand il y a un lien → le fait 4 rougit.

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import Table, {
  THead,
  Th,
  Tr,
  Td,
  CellTitle,
  CellAgent,
  CellText,
  CellMono,
  CellMuted,
  CellActions,
  CellChevron,
  TableDetailRow,
  TableDetailNote,
  TablePagination,
} from '../Table.tsx';

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    className,
    title,
  }: {
    href: string;
    children: unknown;
    className?: string;
    title?: string;
  }) => (
    <a href={href} className={className} title={title}>
      {children as never}
    </a>
  ),
}));

/** Rend un fragment dans un vrai DOM (jsdom) pour le lire par sélecteurs. */
function dom(el: ReactElement): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(el);
  return host;
}

/** Une cellule seule, dans une table valide. */
function cell(content: ReactElement, opts: { top?: boolean } = {}): HTMLElement {
  return dom(
    <table>
      <tbody>
        <Tr>
          <Td top={opts.top}>{content}</Td>
        </Tr>
      </tbody>
    </table>,
  );
}

function classes(el: Element | null | undefined): string[] {
  if (!el) throw new Error('élément absent du rendu');
  return (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
}

/**
 * Toutes les classes de toutes les balises rendues, sauf l'avatar : ses
 * initiales sont la recette d'AgentAvatar (mono + label-11), un composant du
 * DS à part entière, pas une typographie de cellule.
 */
function allClasses(host: HTMLElement): string[] {
  return [...host.querySelectorAll('[class]')]
    .filter((e) => !classes(e).includes('rounded-full'))
    .flatMap((e) => classes(e));
}

/** Ce que la rampe interdit dans une cellule. */
const BRUT = /^(text-(xs|sm|base|lg|xl|legacy-\d+|\[.*\])|font-mono)$/;

describe('Table — la recette de chaque cellule', () => {
  it('CellMono : mono-12 ink-3, chiffres tabulaires, sur une ligne', () => {
    const host = cell(<CellMono>4.2 s</CellMono>);
    const span = host.querySelector('td > span');
    expect(span?.textContent).toBe('4.2 s');
    expect(classes(span)).toEqual(
      expect.arrayContaining(['text-mono-12', 'text-ink-3', 'tabular-nums', 'whitespace-nowrap']),
    );
    expect(classes(span).filter((c) => BRUT.test(c))).toEqual([]);
  });

  it('CellMuted : mono-11 ink-4, le mot tel quel', () => {
    const span = cell(<CellMuted>Unassigned</CellMuted>).querySelector('td > span');
    expect(span?.textContent).toBe('Unassigned');
    expect(classes(span)).toEqual(expect.arrayContaining(['text-mono-11', 'text-ink-4']));
  });

  it('CellTitle : le nom en medium-13 ink, la ligne meta en mono-11 ink-4', () => {
    const host = cell(<CellTitle meta="oauth2">Google Drive</CellTitle>);
    const nom = [...host.querySelectorAll('span')].find((s) => s.textContent === 'Google Drive');
    expect(classes(nom)).toEqual(
      expect.arrayContaining(['text-medium-13', 'text-ink', 'truncate']),
    );
    const meta = [...host.querySelectorAll('div')].find((d) => d.textContent === 'oauth2');
    expect(classes(meta)).toEqual(
      expect.arrayContaining(['text-mono-11', 'text-ink-4', 'break-words']),
    );
  });

  it('CellTitle : la description en body-12 ink-3 sur deux lignes, entière en infobulle', () => {
    const texte = 'Cite the source of every claim, and say when there is none.';
    const host = cell(
      <CellTitle description={texte} badge={<b data-badge>Update available</b>}>
        Citation discipline
      </CellTitle>,
    );
    const desc = [...host.querySelectorAll('div')].find((d) => d.textContent === texte);
    expect(classes(desc)).toEqual(
      expect.arrayContaining(['text-body-12', 'text-ink-3', 'line-clamp-2']),
    );
    expect(desc?.getAttribute('title')).toBe(texte);
    // La pastille est collée au nom, dans la même rangée.
    const badge = host.querySelector('[data-badge]');
    expect(badge?.parentElement?.textContent).toContain('Citation discipline');
  });

  it('CellText : body-13 ink-2 ; `href` en fait un lien, `clamp` le coupe, `quiet` le met en retrait', () => {
    const lien = cell(
      <CellText href="/jobs/1" title="la tâche entière" clamp>
        la tâche
      </CellText>,
    ).querySelector('a');
    expect(lien?.getAttribute('href')).toBe('/jobs/1');
    expect(lien?.getAttribute('title')).toBe('la tâche entière');
    expect(classes(lien)).toEqual(
      expect.arrayContaining(['text-body-13', 'text-ink-2', 'line-clamp-1']),
    );

    const discret = cell(<CellText quiet>un aperçu</CellText>).querySelector('td > div > div');
    expect(classes(discret)).toEqual(expect.arrayContaining(['text-body-12', 'text-ink-3']));
    expect(classes(discret)).not.toContain('text-body-13');
  });

  it('aucune cellule ne porte de classe brute, quelle que soit sa sorte', () => {
    const host = dom(
      <Table>
        <THead>
          <Th />
          <Th>Agent</Th>
          <Th align="right">Calls</Th>
        </THead>
        <tbody>
          <Tr expanded>
            <Td>
              <CellChevron expanded />
            </Td>
            <Td>
              <CellAgent name="Alfred" meta="alfred" />
            </Td>
            <Td align="right">
              <CellMono>3 calls</CellMono>
            </Td>
          </Tr>
          <TableDetailRow colSpan={3} label="Calls">
            <TableDetailNote>No call recorded for this run.</TableDetailNote>
          </TableDetailRow>
          <Tr>
            <Td>
              <CellTitle description="d" meta="m">
                t
              </CellTitle>
            </Td>
            <Td>
              <CellText meta="m">x</CellText>
            </Td>
            <Td>
              <CellActions>
                <span />
              </CellActions>
              <CellMuted>none</CellMuted>
            </Td>
          </Tr>
        </tbody>
      </Table>,
    );
    expect(allClasses(host).filter((c) => BRUT.test(c))).toEqual([]);
  });
});

describe('Table — un agent se rend partout pareil', () => {
  it('avatar rond md, puis le nom à la recette de CellTitle et le slug en meta', () => {
    const host = cell(<CellAgent name="Alfred Pennyworth" meta="alfred" />);
    const avatar = host.querySelector('span.rounded-full');
    expect(avatar?.textContent).toBe('AP');
    expect(classes(avatar)).toContain('h-[30px]');
    const nom = [...host.querySelectorAll('span')].find(
      (s) => s.textContent === 'Alfred Pennyworth',
    );
    expect(classes(nom)).toEqual(expect.arrayContaining(['text-medium-13', 'text-ink']));
    expect(host.textContent).toContain('alfred');
  });

  it('un agent inconnu se dit « Unknown », sans avatar inventé', () => {
    const host = cell(<CellAgent name={null} />);
    expect(host.querySelector('td')?.textContent).toBe('Unknown');
    expect(host.querySelector('span.rounded-full')).toBeNull();
    expect(classes(host.querySelector('td > span'))).toEqual(
      expect.arrayContaining(['text-mono-11', 'text-ink-4']),
    );
  });
});

describe('Table — la ligne dépliée', () => {
  it('son en-tête porte la recette EXACTE des en-têtes de colonne', () => {
    const tete = dom(
      <table>
        <thead>
          <tr>
            <Th>Calls</Th>
          </tr>
        </thead>
      </table>,
    ).querySelector('th');
    const recetteTh = classes(tete).filter((c) => /^(text-|uppercase|tracking-)/.test(c));

    const host = dom(
      <table>
        <tbody>
          <TableDetailRow
            colSpan={8}
            label="Calls"
            action={<span data-action>Open run</span>}
            data-testid="detail"
          >
            <TableDetailNote>Loading calls…</TableDetailNote>
          </TableDetailRow>
        </tbody>
      </table>,
    );
    const ligne = host.querySelector('[data-testid="detail"]');
    expect(ligne?.tagName).toBe('TR');
    expect(classes(ligne)).toContain('bg-canvas');
    expect(host.querySelector('td')?.getAttribute('colspan')).toBe('8');

    const libelle = [...host.querySelectorAll('span')].find((s) => s.textContent === 'Calls');
    const recetteDetail = classes(libelle).filter((c) => /^(text-|uppercase|tracking-)/.test(c));
    // `text-left` n'est que l'alignement du <th> ; tout le reste doit coïncider.
    expect(recetteDetail.sort()).toEqual(recetteTh.filter((c) => c !== 'text-left').sort());
    // L'action est dans l'en-tête, à côté du libellé.
    expect(host.querySelector('[data-action]')?.parentElement).toBe(libelle?.parentElement);

    const note = [...host.querySelectorAll('p')].find((p) => p.textContent === 'Loading calls…');
    expect(classes(note)).toEqual(expect.arrayContaining(['text-body-13', 'text-ink-4']));
  });

  it('sans libellé ni action, elle ne dessine aucun en-tête', () => {
    const host = dom(
      <table>
        <tbody>
          <TableDetailRow colSpan={6}>
            <p>la clé est illisible</p>
          </TableDetailRow>
        </tbody>
      </table>,
    );
    expect(host.querySelector('td')?.children).toHaveLength(1);
    expect(host.querySelector('span')).toBeNull();
  });
});

describe('Table — la ligne qui se déplie', () => {
  it('ouverte : aria-expanded="true" et bg-hover ; fermée : aria-expanded="false" et le survol', () => {
    const ligne = (expanded: boolean | undefined) =>
      dom(
        <table>
          <tbody>
            <Tr interactive expanded={expanded}>
              <Td>x</Td>
            </Tr>
          </tbody>
        </table>,
      ).querySelector('tr');

    const ouverte = ligne(true);
    expect(ouverte?.getAttribute('aria-expanded')).toBe('true');
    expect(classes(ouverte)).toContain('bg-hover');
    expect(classes(ouverte)).not.toContain('hover:bg-hover');

    const fermee = ligne(false);
    expect(fermee?.getAttribute('aria-expanded')).toBe('false');
    expect(classes(fermee)).toContain('hover:bg-hover');
    expect(classes(fermee)).not.toContain('bg-hover');

    // Une ligne qui ne se déplie pas ne prétend pas le pouvoir.
    expect(ligne(undefined)?.hasAttribute('aria-expanded')).toBe(false);
  });

  it('le chevron tourne quand la ligne est ouverte', () => {
    const ouvert = cell(<CellChevron expanded />).querySelector('svg');
    const ferme = cell(<CellChevron expanded={false} />).querySelector('svg');
    expect(classes(ouvert)).toContain('rotate-90');
    expect(classes(ferme)).not.toContain('rotate-90');
  });
});

describe('Table — une seule règle d’alignement', () => {
  it('centré par défaut ; `top` aligne la cellule en haut, et le visuel en tête suit', () => {
    const centre = cell(<CellText lead={<i />}>x</CellText>);
    expect(classes(centre.querySelector('td'))).toContain('align-middle');

    const haut = cell(
      <CellText lead={<i />} meta="m">
        x
      </CellText>,
      { top: true },
    );
    expect(classes(haut.querySelector('td'))).toContain('align-top');
    // La rangée visuel + texte est centrée, sauf sous une cellule `align-top`.
    const rangee = haut.querySelector('td > div');
    expect(classes(rangee)).toEqual(
      expect.arrayContaining(['items-center', '[.align-top_&]:items-start']),
    );
    // Une seule ligne reste centrée sur son visuel, même dans une ligne `top`.
    const seule = cell(<CellText lead={<i />}>x</CellText>, { top: true }).querySelector(
      'td > div',
    );
    expect(classes(seule)).not.toContain('[.align-top_&]:items-start');
  });
});

describe('Table — la pagination', () => {
  it('première page : Previous est un bouton désactivé, Next un lien', () => {
    const host = dom(<TablePagination page={1} prevHref={null} nextHref="/logs?page=2" />);
    expect(host.querySelector('nav')?.getAttribute('aria-label')).toBe('Pagination');
    const prev = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Previous');
    expect(prev, 'Previous a disparu au lieu d’être désactivé').toBeDefined();
    expect(prev?.hasAttribute('disabled')).toBe(true);
    const next = [...host.querySelectorAll('a')].find((a) => a.textContent === 'Next');
    expect(next?.getAttribute('href')).toBe('/logs?page=2');
    const page = [...host.querySelectorAll('span')].find((s) => s.textContent === 'Page 1');
    expect(classes(page)).toEqual(expect.arrayContaining(['text-mono-12', 'text-ink-3']));
  });

  it('dernière page : Previous est un lien, Next un bouton désactivé', () => {
    const host = dom(<TablePagination page={3} prevHref="/logs?page=2" nextHref={null} />);
    const prev = [...host.querySelectorAll('a')].find((a) => a.textContent === 'Previous');
    expect(prev?.getAttribute('href')).toBe('/logs?page=2');
    const next = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Next');
    expect(next?.hasAttribute('disabled')).toBe(true);
    expect(host.textContent).toContain('Page 3');
  });
});
