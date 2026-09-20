// StopRunButton.test.tsx — ARRÊTER CE QUI TOURNE, depuis les trois écrans où
// l'on regarde un travail (#252).
//
// Quatre choses se prouvent ici, et ce sont les quatre qui feraient du bouton un
// menteur :
//
//   1. il n'existe QUE tant que le travail est vivant, et il disparaît au
//      premier statut terminal — un bouton qui reste promet un geste que
//      l'action refuse (`already_terminal`) ;
//   2. il demande confirmation par le dialogue du design system, jamais par une
//      boîte du navigateur (invariant #10) ;
//   3. confirmer appelle bien `cancelJobAction` avec l'identifiant du job de
//      TÊTE — c'est lui qui entraîne ses délégués ;
//   4. il est là, sur la page d'un run, sur un fil dont le tour court, et sur
//      la page d'une session de code — dans la rangée d'actions, sous la barre.
//
// ⚠️ LE VRAI JOB DE QUENTIN N'EST JAMAIS CLIQUÉ. Le geste se prouve ici, sur un
// faux d'action ; les captures montrent l'état affiché, rien de plus.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh }),
  usePathname: () => '/runs/j-1',
  useSearchParams: () => new URLSearchParams(''),
  notFound: () => {
    throw new Error('notFound');
  },
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: ReactNode; href: string }) =>
    createElement('a', { href, ...rest }, children),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// Les faux sont déclarés DANS la fabrique : `vi.mock` remonte en tête du
// fichier, et une variable du module n'existe pas encore à ce moment-là.
vi.mock('@/lib/actions.ts', () => ({
  cancelJobAction: vi.fn(async () => ({ ok: true, data: { status: 'cancelled' } })),
}));

import StopRunButton from '../StopRunButton';
import { canStopRun } from '@/lib/job-live.ts';
import { cancelJobAction } from '@/lib/actions.ts';
import ThreadScreen from '@/app/(dashboard)/chat/[id]/ThreadScreen.tsx';

let container: HTMLDivElement;
let root: Root;

async function render(node: ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** Le bouton lui-même, ou `null` quand l'écran n'en dessine aucun. */
function stop(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('[data-testid="stop-run"] button');
}

const annuler = vi.mocked(cancelJobAction);

beforeEach(() => {
  annuler.mockClear();
  refresh.mockClear();
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  document.body.innerHTML = '';
});

describe('canStopRun — ce qui est encore arrêtable @cap:suivre-execution/moteur', () => {
  // ⚠️ LA RÈGLE DOIT RESTER LISIBLE DU SERVEUR. Elle a vécu une heure dans
  // `StopRunButton`, un module `'use client'` : les trois pages, qui sont des
  // composants serveur, ont rendu 500 (« Attempted to call canStopRun() from
  // the server »). Ni le typage, ni le lint, ni un test qui monte un composant
  // hors de la frontière ne l'ont vu — seule une vraie instance l'a dit.
  //
  // C'est donc le FICHIER qu'on lit ici : il n'y a pas d'autre façon
  // mécanique de dire « ce module reste lisible des deux côtés ».
  it('vit dans un module que le serveur peut lire', () => {
    // `import.meta.url` n'est pas une URL `file:` sous Vitest : le chemin se
    // construit depuis la racine du paquet, que le lanceur fixe.
    const source = readFileSync(resolve(process.cwd(), 'src/lib/job-live.ts'), 'utf8');
    // La DIRECTIVE, pas le mot : ce fichier PARLE de `'use client'` dans son
    // en-tête, et chercher la chaîne rougirait sur son propre commentaire. Une
    // directive est la première instruction du module ; seuls des commentaires
    // peuvent la précéder.
    const premiereInstruction = source
      .split(String.fromCharCode(10))
      .map((l) => l.trim())
      .find((l) => l !== '' && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'));
    expect(premiereInstruction).not.toContain('use client');
  });

  it('accepte les quatre statuts vivants et refuse tout le reste', () => {
    // Les quatre que l'issue nomme, et qui sont ceux du produit
    // (`LIVE_JOB_STATUSES`).
    for (const vivant of ['pending', 'processing', 'awaiting_delegation', 'awaiting_approval']) {
      expect(canStopRun(vivant)).toBe(true);
    }
    for (const fini of ['completed', 'failed', 'cancelled']) {
      expect(canStopRun(fini)).toBe(false);
    }
    // Un statut que le produit ne connaît pas, et l'absence de statut — une
    // session de chat de la CLI n'a pas de job — ne sont PAS arrêtables : on ne
    // propose pas d'arrêter ce qu'on ne sait pas lire (invariant #4).
    expect(canStopRun('chat')).toBe(false);
    expect(canStopRun(null)).toBe(false);
    expect(canStopRun(undefined)).toBe(false);
  });
});

describe('le bouton Stop @cap:suivre-execution/ecran', () => {
  it('n’existe que tant que le travail court', async () => {
    await render(<StopRunButton jobId="j-1" status="processing" />);
    expect(stop()).not.toBeNull();
    expect(stop()!.textContent).toBe('Stop');

    await act(async () => root.unmount());
    await render(<StopRunButton jobId="j-1" status="completed" />);
    expect(stop()).toBeNull();
  });

  it('demande confirmation par le dialogue du design system, et arrête le job de tête', async () => {
    await render(<StopRunButton jobId="j-tete" status="processing" />);
    await click(stop()!);

    // Le dialogue du produit, pas une boîte du navigateur (invariant #10). Il
    // dit ce qui va se passer : l'arrêt est coopératif.
    const dialogue = document.querySelector('[role="dialog"]');
    expect(dialogue).not.toBeNull();
    expect(dialogue!.textContent).toContain('Stop this run?');
    expect(dialogue!.textContent).toContain('at the next check');
    expect(dialogue!.textContent).toContain('delegated');
    // ET RIEN QUE ÇA. Le texte a promis un moment que « le fil dit que le run
    // a été arrêté » : personne ne l'écrit, et le fil ne rend un bloc que si le
    // job porte une erreur ou un résultat, qu'une annulation ne pose pas.
    expect(dialogue!.textContent).not.toContain('the thread says');
    // Rien n'a encore été annulé : ouvrir la confirmation n'arrête rien.
    expect(annuler).not.toHaveBeenCalled();

    const confirmer = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Stop run',
    );
    expect(confirmer).toBeDefined();
    await click(confirmer!);

    // L'IDENTIFIANT DU JOB DE TÊTE, celui qui entraîne ses délégués.
    expect(annuler).toHaveBeenCalledWith('j-tete');
    // Et la page se relit : la pastille d'état et ce bouton sont rendus par le
    // serveur, ils resteraient sur l'état d'avant le clic.
    expect(refresh).toHaveBeenCalled();
  });

  it('renonce sans rien arrêter quand on garde le run', async () => {
    await render(<StopRunButton jobId="j-1" status="awaiting_approval" />);
    await click(stop()!);
    const garder = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Keep running',
    );
    await click(garder!);
    expect(annuler).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe('la rangée d’actions d’un écran de fil @cap:suivre-execution/ecran', () => {
  it('porte le bouton HORS de la zone qui défile', () => {
    const html = renderToStaticMarkup(
      <ThreadScreen
        actions={<span data-testid="une-action">Stop</span>}
        actionsBox="mx-auto max-w-[760px]"
      >
        <p>le fil</p>
      </ThreadScreen>,
    );
    // La rangée du design system (#242), et l'action dedans.
    expect(html).toContain('data-testid="action-row"');
    expect(html).toContain('data-testid="une-action"');
    // AVANT le contenu qui défile : un fil s'ouvre par sa fin, et une rangée
    // posée en tête du contenu serait déjà remontée hors de l'écran.
    expect(html.indexOf('data-testid="action-row"')).toBeLessThan(html.indexOf('le fil'));
    // Et DANS LA BOÎTE QUE L'APPELANT DONNE (Reviewer C, passe 1). Sans elle,
    // le bouton tenait le bord droit de l'écran pendant que le corps d'un run
    // s'arrêtait 384 px plus à gauche sur un écran de 1920.
    expect(html).toContain('max-w-[760px]');
    // Jamais la borne du mode ordinaire : les trois écrans de fil passent
    // `fluid` pour ne pas l'avoir (#237), et elle rentrerait par ici.
    expect(html).not.toContain('max-w-6xl');
  });

  it('ne dessine aucune rangée quand rien ne court', () => {
    const html = renderToStaticMarkup(
      <ThreadScreen>
        <p>le fil</p>
      </ThreadScreen>,
    );
    expect(html).not.toContain('data-testid="action-row"');
  });
});
