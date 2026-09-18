// RunsFolderList.test.tsx — le dossier MCP, RENDU (18/09/2026).
//
// Ce qu'il prouve, et qu'aucun test pur ne voit : le dossier affiche bien ses
// runs, chacun avec son titre et un lien vers SA page, et il ne porte ni
// saisie, ni bouton « New conversation », ni case à cocher — ces gestes-là
// agissent sur des conversations, et ces lignes n'en sont pas.
//
// Rendu dans jsdom, assertions sur le CONTENU rendu — le texte, les adresses —
// jamais sur des appels comptés (invariant #5).
//
// Mutations vérifiées : `href` de `runRows` ramené à `/chat/<id>` → « mène à la
// page du run » rougit ; l'état vide remplacé par une boîte vide → « dit qu'il
// n'y a rien » rougit.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import RunsFolderList from '../RunsFolderList.tsx';
import { runRows } from '../run-rows.ts';
import type { ExternalRunRow } from '@/lib/conversation-actions.ts';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function rendre(
  runs: ExternalRunRow[],
  waiting: { rootJobId: string | null; kind: string }[] = [],
) {
  act(() => {
    root.render(<RunsFolderList rows={runRows({ runs, waiting, now: new Date() })} />);
  });
}

const DEUX_RUNS: ExternalRunRow[] = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    task: 'Résumer les tickets ouverts',
    status: 'processing',
    createdAt: new Date(),
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    task: 'Publier la note de version',
    status: 'completed',
    createdAt: new Date(),
  },
];

describe('le dossier MCP liste les runs venus de dehors @cap:parler-par-canal-externe/ecran', () => {
  it('affiche chaque run avec son titre, et mène à la page du run', () => {
    rendre(DEUX_RUNS);
    const liens = [...container.querySelectorAll('a')];
    expect(liens.map((a) => a.getAttribute('href'))).toEqual([
      '/jobs/11111111-1111-1111-1111-111111111111',
      '/jobs/22222222-2222-2222-2222-222222222222',
    ]);
    expect(container.textContent).toContain('Résumer les tickets ouverts');
    expect(container.textContent).toContain('Publier la note de version');
  });

  it('dit sur la ligne ce qui attend la personne, et ce qui tourne', () => {
    rendre(DEUX_RUNS, [{ rootJobId: '22222222-2222-2222-2222-222222222222', kind: 'question' }]);
    expect(container.textContent).toContain('Question asked');
    // Le premier run TOURNE : le point vert de la ligne, et lui seul — un
    // point, jamais un nombre.
    const lignes = [...container.querySelectorAll('a')];
    expect(lignes[0]?.querySelector('.bg-ok')).not.toBeNull();
    expect(lignes[1]?.querySelector('.bg-ok')).toBeNull();
  });

  it('n’offre NI composition, NI création, NI sélection — ce ne sont pas des conversations', () => {
    rendre(DEUX_RUNS);
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.textContent).not.toContain('New conversation');
    expect(container.textContent).not.toContain('Select');
    expect(container.textContent).not.toContain('Delete');
  });

  it('dit qu’il n’y a rien plutôt que de montrer une boîte vide', () => {
    rendre([]);
    expect(container.textContent).toContain('No run started from outside Nodal yet.');
    expect(container.querySelector('a')).toBeNull();
  });
});
