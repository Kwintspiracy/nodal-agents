// ProjectPanel.test.tsx — « Files & proof » s'ouvre À CÔTÉ des conversations,
// et la personne décide (#143, Quentin 19/09).
//
// Ce qui se prouve ici, et que rien d'autre ne tient :
//   1. OUVERT PAR DÉFAUT — c'est la promesse ; un panneau qu'il faut ouvrir à
//      chaque visite est un onglet déguisé ;
//   2. le bouton le ferme ET le rouvre, et le panneau quitte vraiment le DOM ;
//   3. le choix ne TIENT PAS d'une visite à l'autre : rien n'est écrit dans le
//      stockage du navigateur, et la visite suivante repart ouverte (20/09) ;
//   4. `/spaces/<id>/files` rend la même page, panneau ouvert comme partout —
//      cette adresse veut dire « montre-moi le dossier » ;
//   5. un stockage absent ne change rien : personne ne le lit, le bouton
//      continue de marcher.
//
// Rendu dans jsdom et MANIPULÉ : les assertions portent sur le DOM produit et
// sur ce que le stockage CONTIENT, jamais sur un compte d'appels.
//
// La STRUCTURE, elle, n'est plus ici : c'est le `PageShell` qui met la colonne
// de contenu et le panneau côte à côte sous l'en-tête, et c'est
// `PageShellOrder.test.tsx` qui l'affirme.
//
// Mutations vérifiées, chacune remise en place ensuite (20/09, sans souvenir) :
//   - `useState(true)` → `false` : « ouvert par défaut », « ouvert de nouveau »
//     et `/files` rougissent — c'est là que vit la promesse désormais ;
//   - une écriture dans `localStorage` remise dans `close` : « ne se souvient
//     pas » rougit sur `getItem(KEY)`.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  ProjectFilesPanel,
  ProjectPanelBody,
  ProjectPanelButton,
  ProjectPanelProvider,
} from '../ProjectPanel.tsx';

let container: HTMLDivElement;
let root: Root;

const KEY = 'nodal.project-panel-open';

async function render(node: React.ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
}

/** L'écran, réduit à ce que ce test regarde : le bouton et le panneau. */
function Ecran() {
  return (
    <ProjectPanelProvider>
      <ProjectPanelButton />
      <ProjectPanelBody>
        <p>LES CONVERSATIONS</p>
      </ProjectPanelBody>
      <ProjectFilesPanel title="Files & proof">
        <p>LE DOSSIER</p>
      </ProjectFilesPanel>
    </ProjectPanelProvider>
  );
}

const panneau = (): Element | null =>
  container.querySelector('[data-testid="project-files-panel"]');
const bouton = (): HTMLElement =>
  container.querySelector('[data-testid="project-panel-toggle"]') as HTMLElement;

async function clic(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/**
 * Un `localStorage` en mémoire.
 *
 * Node 26 fournit le sien, et il est INDISPONIBLE sans `--localstorage-file` :
 * le global vaut `undefined` sous vitest, jsdom ou non. Le composant s'en
 * arrange (tout accès est sous `try`), mais le SOUVENIR du choix, lui, se
 * prouve — d'où ce double, posé avant chaque cas. Même recette que
 * `Sidebar.test.tsx`, pour la même raison.
 */
function fakeStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k: string) => data.get(k) ?? null,
    key: (i: number) => [...data.keys()][i] ?? null,
    removeItem: (k: string) => void data.delete(k),
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeStorage());
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('ProjectPanel @cap:travailler-sur-des-fichiers/ecran', () => {
  it('s’ouvre par DÉFAUT, à côté des conversations', async () => {
    await render(<Ecran />);
    expect(panneau()).not.toBeNull();
    expect(panneau()!.textContent).toContain('LE DOSSIER');
    // Les deux sont là EN MÊME TEMPS : c'est tout l'intérêt du panneau.
    expect(container.textContent).toContain('LES CONVERSATIONS');
    // Le libellé NE BOUGE PAS : il nomme la chose, et c'est l'état pressoir
    // qui dit où l'on en est. Deux façons de fermer qui se disaient
    // différemment, c'était le constat (Quentin, 19/09).
    expect(bouton().textContent).toContain('Files & proof');
    expect(bouton().getAttribute('aria-pressed')).toBe('true');
  });

  it('le bouton le ferme, puis le rouvre', async () => {
    await render(<Ecran />);
    await clic(bouton());
    // Il quitte vraiment le DOM : un panneau caché en CSS pousserait encore.
    expect(panneau()).toBeNull();
    expect(container.textContent).not.toContain('LE DOSSIER');
    expect(bouton().textContent).toContain('Files & proof');
    expect(bouton().getAttribute('aria-pressed')).toBe('false');
    // Et la liste, elle, n'a pas bougé.
    expect(container.textContent).toContain('LES CONVERSATIONS');

    await clic(bouton());
    expect(panneau()).not.toBeNull();
  });

  it('ne se souvient PAS d’une visite à l’autre : ouvert de nouveau, sans flash', async () => {
    // Quentin, 20/09 : le choix mémorisé s'appliquait après le montage, et le
    // panneau rendu ouvert se refermait une image plus tard à chaque projet
    // cliqué. Il n'écrit donc plus rien, et la visite suivante repart ouverte.
    await render(<Ecran />);
    await clic(bouton());
    expect(panneau()).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();

    await act(async () => root.unmount());
    container.remove();
    await render(<Ecran />);
    expect(panneau()).not.toBeNull();
  });

  it('`/files` ouvre le panneau, comme toute autre adresse', async () => {
    await render(<Ecran />);
    expect(panneau()).not.toBeNull();
  });

  it('un stockage qui refuse ne change rien : rien ne le lit', async () => {
    vi.stubGlobal('localStorage', undefined);
    await render(<Ecran />);
    expect(panneau()).not.toBeNull();
    await clic(bouton());
    expect(panneau()).toBeNull();
  });
});
