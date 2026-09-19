// ProjectPanel.test.tsx — « Files & proof » s'ouvre À CÔTÉ des conversations,
// et la personne décide (#143, Quentin 19/09).
//
// Ce qui se prouve ici, et que rien d'autre ne tient :
//   1. OUVERT PAR DÉFAUT — c'est la promesse ; un panneau qu'il faut ouvrir à
//      chaque visite est un onglet déguisé ;
//   2. le bouton le ferme ET le rouvre, et le panneau quitte vraiment le DOM ;
//   3. le choix TIENT d'une visite à l'autre : il est écrit dans le stockage du
//      navigateur, et relu au montage suivant ;
//   4. `/spaces/<id>/files` (`forceOpen`) l'ouvre malgré un choix « fermé » —
//      cette adresse veut dire « montre-moi le dossier » ;
//   5. la STRUCTURE : le panneau est le frère du contenu sous l'en-tête, et la
//      barre d'outils vit dans la colonne de gauche ;
//   6. un stockage qui REFUSE de répondre n'emporte pas l'écran : le défaut
//      tient, et le bouton continue de marcher.
//
// Rendu dans jsdom et MANIPULÉ : les assertions portent sur le DOM produit et
// sur ce que le stockage CONTIENT, jamais sur un compte d'appels.
//
// Mutations vérifiées, chacune remise en place ensuite :
//   - le défaut de l'effet, `!== 'closed'` → `=== 'open'` : trois cas rougissent,
//     dont « ouvert par défaut ». C'est LÀ que vit la promesse, et pas dans
//     l'état initial : `useState(true)` → `false` ne fait PAS rougir ce cas-là,
//     l'effet rouvrant le panneau au montage. Il rougit les deux cas où l'effet
//     ne décide pas — `forceOpen` et le stockage absent ;
//   - l'écriture dans `localStorage` retirée : « le choix tient » rougit ;
//   - `if (forceOpen) return` retiré de l'effet : le cas `forceOpen` rougit.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ProjectPanelButton, ProjectPanelLayout, ProjectPanelProvider } from '../ProjectPanel.tsx';

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
function Ecran({ forceOpen = false }: { forceOpen?: boolean }) {
  return (
    <ProjectPanelProvider forceOpen={forceOpen}>
      <ProjectPanelLayout
        title="Files & proof"
        toolbar={<ProjectPanelButton />}
        panel={<p>LE DOSSIER</p>}
      >
        <p>LES CONVERSATIONS</p>
      </ProjectPanelLayout>
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

  it('UNE rangée sous l’en-tête : le panneau est le FRÈRE du contenu, pas son cadet', async () => {
    // Le constat (Quentin, 19/09) : la barre d'outils, passée au `toolbar` du
    // `PageShell`, faisait un bandeau pleine largeur AU-DESSUS du panneau — le
    // panneau commençait plus bas que le filet de l'en-tête, et le bandeau
    // traînait à gauche des boutons une bande vide. Ce qui se vérifie ici est
    // la structure qui l'empêche, pas sa peinture.
    await render(<Ecran />);
    const p = panneau()!;
    const rangee = p.parentElement!;
    const colonne = p.previousElementSibling!;

    // Le panneau et la colonne de contenu sont dans la MÊME rangée.
    expect(rangee.contains(colonne)).toBe(true);
    expect(rangee.className).toContain('flex');

    // La barre d'outils est DANS la colonne de gauche — donc au-dessus de la
    // liste, et jamais au-dessus du panneau.
    expect(colonne.contains(bouton())).toBe(true);
    expect(p.contains(bouton())).toBe(false);
    // Et rien qui contienne la barre ne contient le panneau, sauf la rangée
    // elle-même et ce qui l'englobe.
    const barre = bouton().parentElement!;
    expect(barre.contains(p)).toBe(false);
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

  it('le choix TIENT d’une visite à l’autre', async () => {
    await render(<Ecran />);
    await clic(bouton());
    expect(window.localStorage.getItem(KEY)).toBe('closed');

    // La visite suivante : un montage neuf, qui relit le choix.
    await act(async () => root.unmount());
    container.remove();
    await render(<Ecran />);
    expect(panneau()).toBeNull();

    await clic(bouton());
    expect(window.localStorage.getItem(KEY)).toBe('open');
  });

  it('`/files` ouvre le panneau MALGRÉ un choix « fermé »', async () => {
    window.localStorage.setItem(KEY, 'closed');
    await render(<Ecran forceOpen />);
    expect(panneau()).not.toBeNull();
  });

  it('un stockage qui refuse ne ferme rien : le défaut tient', async () => {
    vi.stubGlobal('localStorage', undefined);
    await render(<Ecran />);
    expect(panneau()).not.toBeNull();
    // Et le bouton continue de marcher : l'écran obéit, seul le souvenir
    // manque.
    await clic(bouton());
    expect(panneau()).toBeNull();
  });
});
