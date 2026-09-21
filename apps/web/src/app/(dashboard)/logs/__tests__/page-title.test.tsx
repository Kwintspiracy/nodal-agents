// page-title.test.tsx — LE TITRE DE LA PAGE QUE LA CASE « RUNS » OUVRE.
//
// Constat de Reviewer C sur la PR #400 : le rail venait d'être renommé
// « Runs » (planche Figma `46:1330`), et la page au bout du lien s'appelait
// encore « Logs ». Un menu qui promet un mot et une page qui en affiche un
// autre, c'est le renommage fait à moitié.
//
// Ce fichier rend la VRAIE page de `/logs`, dans ses deux onglets, et lit le
// `h1` obtenu. Les listes et les filtres sont remplacés par du vide : ils
// appellent chacun leur action serveur, et les monter ici ne dirait rien de
// plus sur le titre.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: ReactNode; href: string }) =>
    createElement('a', { href, ...rest }, children),
}));
vi.mock('@/lib/actions.ts', () => ({
  listActivityRunsAction: vi.fn(),
  listAgentsAction: vi.fn(),
  listServiceLogsAction: vi.fn(),
  listToolNamesAction: vi.fn(),
}));
vi.mock('../LogFilters.tsx', () => ({ default: () => null }));
vi.mock('../RunsList.tsx', () => ({ default: () => null }));
vi.mock('../ServiceLogsPanel.tsx', () => ({ default: () => null }));
vi.mock('../../spaces/LiveRefresh.tsx', () => ({ default: () => null }));
vi.mock('@/components/SendTaskForm.tsx', () => ({ default: () => null }));

import LogsPage from '../page.tsx';
import {
  listActivityRunsAction,
  listAgentsAction,
  listServiceLogsAction,
  listToolNamesAction,
} from '@/lib/actions.ts';
import { RAIL_FOOT } from '@/components/sidebar-nav.ts';

let container: HTMLDivElement;
let root: Root;

async function rendre(node: ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
}

/** Le titre que la page affiche, tel que `PageShell` le rend. */
function titre(): string {
  return container.querySelector('h1')?.textContent?.trim() ?? '';
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.mocked(listAgentsAction).mockResolvedValue({ ok: true, data: [] });
  vi.mocked(listToolNamesAction).mockResolvedValue({ ok: true, data: [] });
  vi.mocked(listServiceLogsAction).mockResolvedValue({ ok: true, data: [] });
  vi.mocked(listActivityRunsAction).mockResolvedValue({
    ok: true,
    data: { items: [], hasMore: false },
  } as unknown as Awaited<ReturnType<typeof listActivityRunsAction>>);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
});

describe('la page de /logs porte le nom de sa case @cap:suivre-execution/ecran', () => {
  it('s’appelle comme la case du rail qui y mène', async () => {
    // Le titre n'est pas comparé à une constante écrite ici : il est comparé au
    // LIBELLÉ DE LA CASE, lu dans la table des destinations. Le jour où la case
    // change encore de nom, c'est ce cas qui dit que la page ne l'a pas suivi.
    //
    // Mutation vérifiée : `title="Logs"` remis sur la vue Activity → ce cas
    // rougit.
    await rendre(await LogsPage({ searchParams: Promise.resolve({}) }));
    expect(titre()).toBe(RAIL_FOOT.logs.label);
    expect(titre()).toBe('Runs');
  });

  it('garde son nom À LUI sur l’onglet des logs de service', async () => {
    // L'autre onglet montre les journaux du runner et du web, pas des runs :
    // l'appeler « Runs » aurait recréé la confusion à l'envers. Il porte le nom
    // que son onglet écrit déjà.
    await rendre(await LogsPage({ searchParams: Promise.resolve({ view: 'service' }) }));
    expect(titre()).toBe('Service logs');
  });

  it('s’appelle encore « Runs » quand la lecture ÉCHOUE', async () => {
    // Le repli d'erreur est une page comme les autres : un titre « Logs » n'y
    // serait pas moins faux parce que la liste n'a pas pu être lue.
    vi.mocked(listActivityRunsAction).mockResolvedValue({
      ok: false,
      message: 'boom',
    } as unknown as Awaited<ReturnType<typeof listActivityRunsAction>>);
    await rendre(await LogsPage({ searchParams: Promise.resolve({}) }));
    expect(titre()).toBe('Runs');
    expect(container.textContent).toContain('boom');
  });
});
