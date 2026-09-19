// BackButton.test.tsx — « Back » revient à la page d'où l'on vient (#232).
//
// Constat du propriétaire, deux fois le 19/09 : une automation puis un de ses
// runs ramenait à Scheduled ; un workspace puis une de ses conversations
// ramenait à Nodal chats. Chaque page de détail codait sa destination en dur.
//
// Ce que ces cas prouvent : la navigation RÉELLEMENT demandée au routeur —
// le chemin poussé, ou le dépilement quand l'historique s'y prête — jamais un
// compte d'appels.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  recordVisit,
  serializeTrail,
  TRAIL_STORAGE_KEY,
  type TrailEntry,
} from '@/lib/navigation-trail.ts';

const routeur = vi.hoisted(() => ({
  push: vi.fn<(href: string) => void>(),
  back: vi.fn<() => void>(),
  pathname: '/',
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routeur.push, back: routeur.back }),
  usePathname: () => routeur.pathname,
}));

import BackButton from '../BackButton.tsx';

/** Le fil tel qu'il serait après ces visites : l'appel réel, pas un JSON à la main. */
function poserLeFil(paths: readonly string[]): void {
  let trail: TrailEntry[] = [];
  for (const p of paths) trail = recordVisit(trail, p, null).trail;
  window.sessionStorage.setItem(TRAIL_STORAGE_KEY, serializeTrail(trail));
}

async function cliquerSurBack(parent: string, label = 'Back'): Promise<void> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<BackButton parent={parent} label={label} />);
  });
  const lien = container.querySelector<HTMLAnchorElement>('[data-testid="back-button"]');
  if (!lien) throw new Error('la page n’a pas dessiné le retour');
  // Le `href` reste le parent : clic du milieu et « ouvrir dans un nouvel
  // onglet » mènent quelque part de sensé.
  expect(lien.getAttribute('href')).toBe(parent);
  await act(async () => {
    lien.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  });
}

beforeEach(() => {
  routeur.push.mockClear();
  routeur.back.mockClear();
  window.sessionStorage.clear();
});

describe('BackButton — revenir d’où l’on vient @cap:suivre-execution/ecran', () => {
  it('fil présent : depuis un workspace, la conversation revient AU WORKSPACE', async () => {
    // Les deux pages se suivent dans l'historique de l'onglet : on dépile, ce
    // qui rend la position de défilement. Ce qui compte est qu'on ne parte PAS
    // au parent — « Nodal chats », le défaut constaté le 19/09.
    poserLeFil(['/spaces/ws-1', '/chat/c-9']);
    routeur.pathname = '/chat/c-9';
    await cliquerSurBack('/chat');
    expect(routeur.back).toHaveBeenCalled();
    expect(routeur.push.mock.calls.map((c) => c[0])).toEqual([]);
  });

  it('fil présent, historique non adjacent : le CHEMIN de la page précédente est poussé', async () => {
    const trail: TrailEntry[] = [
      { path: '/automations', key: 0 },
      { path: '/scheduled/run-7', key: 5 },
    ];
    window.sessionStorage.setItem(TRAIL_STORAGE_KEY, serializeTrail(trail));
    routeur.pathname = '/scheduled/run-7';
    await cliquerSurBack('/scheduled');
    expect(routeur.push.mock.calls.map((c) => c[0])).toEqual(['/automations']);
    expect(routeur.back).not.toHaveBeenCalled();
  });

  it('fil vide : « Back » va au PARENT que la page nomme (lien collé dans un nouvel onglet)', async () => {
    routeur.pathname = '/scheduled/run-7';
    await cliquerSurBack('/scheduled');
    expect(routeur.push.mock.calls.map((c) => c[0])).toEqual(['/scheduled']);
    expect(routeur.back).not.toHaveBeenCalled();
  });

  it('le fil ne garde pas une page hors de l’app : après /login, « Back » va au parent', async () => {
    poserLeFil(['/login', '/scheduled/run-7']);
    routeur.pathname = '/scheduled/run-7';
    await cliquerSurBack('/scheduled');
    expect(routeur.push.mock.calls.map((c) => c[0])).toEqual(['/scheduled']);
    expect(routeur.back).not.toHaveBeenCalled();
  });

  it('un chemin trompeur glissé dans le stockage n’atteint JAMAIS le routeur', async () => {
    // Revue #234, passe 1 : `/\evil.example.com` commence par un seul slash,
    // mais le navigateur le relit comme `//evil.example.com`. Il passait la
    // garde et arrivait jusqu'à `router.push()`.
    for (const menteur of ['/\\evil.example.com', '/%2Fevil.example.com', '/\x00/evil']) {
      routeur.push.mockClear();
      routeur.back.mockClear();
      window.sessionStorage.setItem(
        TRAIL_STORAGE_KEY,
        serializeTrail([
          { path: menteur, key: 0 },
          { path: '/chat/c-9', key: 1 },
        ]),
      );
      routeur.pathname = '/chat/c-9';
      await cliquerSurBack('/chat');
      expect(routeur.push.mock.calls.map((c) => c[0])).toEqual(['/chat']);
      expect(routeur.back).not.toHaveBeenCalled();
    }
  });

  it('le même écran atteint par deux chemins repart à deux endroits', async () => {
    const depuis = async (liste: string): Promise<string[]> => {
      routeur.push.mockClear();
      window.sessionStorage.setItem(
        TRAIL_STORAGE_KEY,
        serializeTrail([
          { path: liste, key: 0 },
          { path: '/jobs/j-1', key: 6 },
        ]),
      );
      routeur.pathname = '/jobs/j-1';
      await cliquerSurBack('/logs');
      return routeur.push.mock.calls.map((c) => c[0]);
    };
    expect(await depuis('/logs')).toEqual(['/logs']);
    expect(await depuis('/automations')).toEqual(['/automations']);
  });

  it('Ctrl+clic laisse le navigateur ouvrir le parent dans un onglet, sans rien demander au routeur', async () => {
    poserLeFil(['/spaces/ws-1', '/chat/c-9']);
    routeur.pathname = '/chat/c-9';
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<BackButton parent="/chat" label="Back to channels" />);
    });
    const lien = container.querySelector<HTMLAnchorElement>('[data-testid="back-button"]');
    if (!lien) throw new Error('la page n’a pas dessiné le retour');
    const evenement = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
      ctrlKey: true,
    });
    // On relève le verdict APRÈS le composant, puis on arrête l'événement :
    // jsdom ne sait pas naviguer et le dirait à chaque exécution.
    let empeche: boolean | null = null;
    const temoin = (e: Event): void => {
      empeche = e.defaultPrevented;
      e.preventDefault();
    };
    document.addEventListener('click', temoin);
    await act(async () => {
      lien.dispatchEvent(evenement);
    });
    document.removeEventListener('click', temoin);
    expect(routeur.push).not.toHaveBeenCalled();
    expect(routeur.back).not.toHaveBeenCalled();
    // Rien n'est empêché : le navigateur ouvre le `href`, c'est-à-dire le parent.
    expect(empeche).toBe(false);
  });
});
