// RowActions.test.tsx — les trois points d'une ligne de la barre, et ce qu'ils
// font vraiment (20/09) : le menu s'ouvre, « Rename » envoie le NOUVEAU nom à
// l'action de la bonne sorte, « Delete » ne part qu'après confirmation, et la
// liste se relit après chaque geste. Les assertions lisent les ARGUMENTS des
// actions, pas un compte d'appels.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

let pathname = '/agents';
const push = vi.fn();
const refresh = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push, refresh }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/actions.ts', () => ({
  deleteAgentAction: vi.fn(),
  deleteConversationAction: vi.fn(),
  deleteScheduleAction: vi.fn(),
  deleteWebhookTriggerAction: vi.fn(),
  renameCodeProjectAction: vi.fn(),
  setCodeProjectHiddenAction: vi.fn(),
}));
vi.mock('@/lib/row-actions.ts', () => ({
  renameAgentAction: vi.fn(),
  renameConversationAction: vi.fn(),
  renameScheduleAction: vi.fn(),
  renameWebhookTriggerAction: vi.fn(),
}));

import RowActions from '../RowActions.tsx';
import {
  deleteAgentAction,
  setCodeProjectHiddenAction,
  renameCodeProjectAction,
} from '@/lib/actions.ts';
import { renameAgentAction } from '@/lib/row-actions.ts';

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

function click(el: Element | null): Promise<void> {
  if (!el) throw new Error('nothing to click');
  return act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function bouton(texte: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === texte,
    ) ?? null
  );
}

async function saisir(input: HTMLInputElement, valeur: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, valeur);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
  pathname = '/agents';
  vi.clearAllMocks();
  vi.mocked(renameAgentAction).mockResolvedValue({ ok: true, data: undefined });
  vi.mocked(deleteAgentAction).mockResolvedValue({ ok: true, data: undefined });
  vi.mocked(renameCodeProjectAction).mockResolvedValue({ ok: true, data: undefined });
  vi.mocked(setCodeProjectHiddenAction).mockResolvedValue({ ok: true, data: undefined });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
});

describe('les trois points d’une ligne @cap:creer-agent/ecran', () => {
  it('ouvre un menu Rename / Delete, fermé tant qu’on ne clique pas', async () => {
    const onDone = vi.fn();
    await render(
      createElement(RowActions, {
        kind: 'agent',
        id: 'a1',
        name: 'Researcher',
        href: '/agents/a1',
        onDone,
      }),
    );
    expect(container.querySelector('[role="menu"]')).toBeNull();
    await click(container.querySelector('[data-testid="row-menu-agent"]'));
    const items = [...container.querySelectorAll('[role="menuitem"]')].map((b) =>
      b.textContent?.trim(),
    );
    expect(items).toEqual(['Rename', 'Delete']);
  });

  it('Rename envoie le NOUVEAU nom à l’action de la sorte, puis relit la liste', async () => {
    const onDone = vi.fn();
    await render(
      createElement(RowActions, {
        kind: 'agent',
        id: 'a1',
        name: 'Researcher',
        href: '/agents/a1',
        onDone,
      }),
    );
    await click(container.querySelector('[data-testid="row-menu-agent"]'));
    await click(bouton('Rename'));
    const input = document.getElementById('rename-agent-name') as HTMLInputElement | null;
    expect(input?.value).toBe('Researcher');
    await saisir(input!, 'Scout');
    await click(bouton('Save'));
    expect(vi.mocked(renameAgentAction).mock.calls[0]?.[0]).toEqual({ id: 'a1', name: 'Scout' });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    // La modale est refermée.
    expect(document.getElementById('rename-agent-name')).toBeNull();
  });

  it('Delete demande confirmation, supprime, et remonte à la section si on était dessus', async () => {
    pathname = '/agents/a1/edit';
    const onDone = vi.fn();
    await render(
      createElement(RowActions, {
        kind: 'agent',
        id: 'a1',
        name: 'Researcher',
        href: '/agents/a1',
        onDone,
      }),
    );
    await click(container.querySelector('[data-testid="row-menu-agent"]'));
    await click(bouton('Delete'));
    // Rien n'est parti tant que la confirmation n'est pas donnée.
    expect(deleteAgentAction).not.toHaveBeenCalled();
    // Le bouton de la confirmation porte le même mot que l'entrée du menu.
    const confirmations = [...document.querySelectorAll<HTMLButtonElement>('button')].filter(
      (b) => b.textContent?.trim() === 'Delete',
    );
    await click(confirmations[confirmations.length - 1] ?? null);
    expect(vi.mocked(deleteAgentAction).mock.calls[0]?.[0]).toBe('a1');
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0]?.[0]).toBe('/agents');
  });

  it('un projet se RETIRE de la liste par son chemin, il n’est pas supprimé', async () => {
    const onDone = vi.fn();
    await render(
      createElement(RowActions, {
        kind: 'project',
        id: 'p1',
        name: 'Recipes',
        href: '/spaces/p1',
        path: 'D:/work/recipes',
        onDone,
      }),
    );
    await click(container.querySelector('[data-testid="row-menu-project"]'));
    expect([...container.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent)).toEqual([
      'Rename',
      'Remove from list',
    ]);
    await click(bouton('Remove from list'));
    const confirmations = [...document.querySelectorAll<HTMLButtonElement>('button')].filter(
      (b) => b.textContent?.trim() === 'Remove from list',
    );
    await click(confirmations[confirmations.length - 1] ?? null);
    expect(vi.mocked(setCodeProjectHiddenAction).mock.calls[0]?.[0]).toEqual({
      projectPath: 'D:/work/recipes',
      hidden: true,
    });
    expect(deleteAgentAction).not.toHaveBeenCalled();
  });

  it('la confirmation DIT où le projet part, ce qui reste, et par où il revient', async () => {
    // #364 : « leaves the list » ne disait ni quelle liste, ni que le geste se
    // défait. Le texte lu à l'écran est ce qui est vérifié.
    await render(
      createElement(RowActions, {
        kind: 'project',
        id: 'p1',
        name: 'Recipes',
        href: '/spaces/p1',
        path: 'D:/work/recipes',
        onDone: vi.fn(),
      }),
    );
    await click(container.querySelector('[data-testid="row-menu-project"]'));
    await click(bouton('Remove from list'));
    const texte = document.body.textContent ?? '';
    expect(texte).toContain('"Recipes" leaves the sidebar and the Projects page.');
    expect(texte).toContain('Its folder stays on disk.');
    expect(texte).toContain('You can show it again from the Projects page.');
    // Pas de tiret cadratin dans un texte d'écran.
    expect(texte).not.toContain('—');
  });
});
