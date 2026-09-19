// ConversationsList.test.tsx — la barre d'actions du dossier « Nodal chats ».
//
// Ce qu'elle prouve, et que le module de lignes ne peut pas prouver : le
// dossier porte de quoi CRÉER une conversation (Quentin, 18/09 : « je n'ai plus
// d'option pour créer un nouveau chat »), de quoi en chercher une, et de quoi
// en supprimer plusieurs — et que le bouton mène vraiment au fil créé.
//
// Rendu dans jsdom et CLIQUÉ, pas seulement rendu : les assertions portent sur
// ce que l'action mockée a reçu et sur l'adresse poussée (invariant #5).
//
// Mutations vérifiées — la barre retirée du rendu : les trois premiers tests
// rougissent ; « Delete » qui supprime sans confirmer : le test de la
// confirmation rougit ; la recherche branchée sur un autre champ : le test du
// filtre rougit.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ConversationsList from '../ConversationsList.tsx';
import { chatFolderView } from '../folder-view.ts';
import type { ConversationRowModel } from '../conversation-rows.ts';

type CreationResult =
  | { ok: true; data: { id: string } }
  | { ok: false; code: string; message: string };

const createConversationAction = vi.hoisted(() =>
  vi.fn(async (): Promise<CreationResult> => ({ ok: true as const, data: { id: 'conv-neuve' } })),
);
const deleteConversationsAction = vi.hoisted(() =>
  vi.fn(async (_ids: string[]) => ({ ok: true as const, data: { deleted: _ids.length } })),
);
const push = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock('@/lib/actions.ts', () => ({ createConversationAction, deleteConversationsAction }));
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));

let container: HTMLDivElement;
let root: Root;

function ligne(over: Partial<ConversationRowModel> = {}): ConversationRowModel {
  return {
    id: 'conv-1',
    key: 'conv-1',
    href: '/chat/conv-1',
    agent: null,
    chatName: 'Recettes du dimanche',
    preview: null,
    time: '14:02',
    waiting: null,
    running: false,
    unread: false,
    ...over,
  };
}

async function render(rows: ConversationRowModel[]): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<ConversationsList rows={rows} />);
  });
}

/** Un bouton par son libellé, DANS TOUT LE DOCUMENT — la confirmation est un portail. */
function bouton(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === label,
  );
  if (!found) throw new Error(`aucun bouton « ${label} » — boutons présents : ${libelles()}`);
  return found as HTMLButtonElement;
}

function libelles(): string {
  return [...document.querySelectorAll('button')]
    .map((b) => `« ${(b.textContent ?? '').trim()} »`)
    .join(', ');
}

async function clic(label: string): Promise<void> {
  const el = bouton(label);
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function chercher(texte: string): Promise<void> {
  const el = container.querySelector<HTMLInputElement>('input[type="search"]');
  if (!el) throw new Error('aucun champ de recherche');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(el, texte);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function cases(): HTMLInputElement[] {
  return [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('le dossier « Nodal chats » : sa barre d’actions @cap:reprendre-conversation/ecran', () => {
  it('« New conversation » crée le fil ET y mène', async () => {
    await render([ligne()]);
    await clic('New conversation');
    expect(createConversationAction).toHaveBeenCalledTimes(1);
    // L'adresse RÉELLE du fil rendu par l'action — pas « une navigation a eu
    // lieu ».
    expect(push).toHaveBeenCalledWith('/chat/conv-neuve');
  });

  it('le bouton est là MÊME quand le dossier est vide — c’est là qu’il sert', async () => {
    await render([]);
    await clic('New conversation');
    expect(createConversationAction).toHaveBeenCalledTimes(1);
    // Et l'écran dit qu'il n'y a rien, plutôt qu'une liste blanche.
    expect(container.textContent).toContain('No conversation yet');
  });

  it('sans agent ROOT, l’écran dit où aller et le bouton se ferme', async () => {
    createConversationAction.mockResolvedValueOnce({
      ok: false,
      code: 'no_root_agent',
      message: 'No ROOT agent yet.',
    });
    await render([ligne()]);
    await clic('New conversation');
    expect(container.textContent).toContain('No ROOT agent yet');
    expect(container.querySelector('a[href="/agents"]')).not.toBeNull();
    expect(bouton('New conversation').disabled).toBe(true);
    // Pas de toast rouge par-dessus : la phrase sur l'écran porte le chemin.
    expect(toastError).not.toHaveBeenCalled();
  });

  it('la recherche filtre sur le TITRE', async () => {
    await render([
      ligne({ id: 'c1', key: 'c1', chatName: 'Recettes du dimanche' }),
      ligne({ id: 'c2', key: 'c2', chatName: 'Facture du garage' }),
    ]);
    await chercher('garage');
    expect(container.textContent).toContain('Facture du garage');
    expect(container.textContent).not.toContain('Recettes du dimanche');
  });
});

describe('le dossier « Nodal chats » : supprimer @cap:reprendre-conversation/ecran', () => {
  it('« Select » fait apparaître les cases, une par ligne', async () => {
    await render([ligne({ id: 'c1', key: 'c1' }), ligne({ id: 'c2', key: 'c2' })]);
    expect(cases()).toHaveLength(0);
    await clic('Select');
    expect(cases()).toHaveLength(2);
  });

  it('« Delete » DEMANDE, et ne supprime qu’après confirmation', async () => {
    await render([ligne({ id: 'c1', key: 'c1', chatName: 'Recettes du dimanche' })]);
    await clic('Select');
    await act(async () => {
      cases()[0]!.click();
    });
    await clic('Delete');
    // La demande est posée, et RIEN n'est encore parti.
    expect(document.body.textContent).toContain('Delete this conversation?');
    expect(deleteConversationsAction).not.toHaveBeenCalled();

    // Le bouton de confirmation du dialogue porte le même libellé : c'est le
    // second « Delete » du document, celui du portail.
    const confirmation = [...document.querySelectorAll('button')].filter(
      (b) => (b.textContent ?? '').trim() === 'Delete',
    );
    await act(async () => {
      confirmation[confirmation.length - 1]!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    expect(deleteConversationsAction).toHaveBeenCalledWith(['c1']);
    expect(refresh).toHaveBeenCalled();
  });

  it('« Cancel » sort du mode et décoche tout', async () => {
    await render([ligne({ id: 'c1', key: 'c1' })]);
    await clic('Select');
    await act(async () => {
      cases()[0]!.click();
    });
    await clic('Cancel');
    expect(cases()).toHaveLength(0);
    await clic('Select');
    expect(cases()[0]!.checked).toBe(false);
  });
});

describe('un dossier de CANAL n’a pas cette barre @cap:reprendre-conversation/ecran', () => {
  it('la vue d’un canal ne rend pas la liste qui la porte', () => {
    // La barre vit dans ce composant, et la page ne le rend que sur
    // `showDashboard`. On n'ouvre pas une conversation Telegram depuis le web :
    // c'est la personne à l'autre bout qui écrit la première.
    expect(chatFolderView('telegram', ['telegram']).showDashboard).toBe(false);
    expect(chatFolderView('dashboard', ['telegram']).showDashboard).toBe(true);
  });
});
