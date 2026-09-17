// PendingTurn.test.tsx — le fil entre l'envoi et la réponse (Quentin, 18/09).
//
// Ce qui se prouve : dès Entrée, le message envoyé est DANS le fil et l'agent
// « réfléchit » — avant que l'action serveur ait répondu ; la zone est vidée et
// RESTE ouverte : un second message part sans attendre le premier, et s'ajoute
// au fil ; quand le serveur a rendu une demande (son texte est dans le fil), sa
// copie s'efface, et seulement la sienne — deux « ok » s'effacent l'un après
// l'autre ; si un envoi échoue, son texte revient dans la zone et sa copie
// quitte le fil.
//
// Rendu dans jsdom et TAPÉ ; l'action est mockée avec une promesse PAR APPEL
// qu'on résout NOUS-MÊMES, pour regarder le fil pendant l'attente (invariant
// #5 : l'état visible, pas un nombre d'appels).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ThreadComposer from '../ThreadComposer.tsx';
import PendingTurn, { PendingTurnProvider } from '../PendingTurn.tsx';
import { feedRequests } from '../feed-requests.ts';

type Result = { ok: true } | { ok: false; message: string };
const resolvers: Array<(r: Result) => void> = [];
const sendChatMessageAction = vi.hoisted(() =>
  vi.fn(
    () =>
      new Promise<{ ok: true } | { ok: false; message: string }>((resolve) => {
        resolvers.push(resolve);
      }),
  ),
);
const refresh = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/actions.ts', () => ({
  sendChatMessageAction,
  setAgentModelAndEffortAction: vi.fn(),
  listKeyModelsAction: vi.fn(async () => ({ ok: true, data: [] })),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: toastError } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

let container: HTMLDivElement;
let root: Root;

/** Le fil tel que le serveur le rend : des demandes, dans l'ordre. */
function feed(...texts: string[]): string[] {
  return feedRequests(texts.map((text) => ({ kind: 'request', text })));
}

/** L'écran, réduit à ce qui compte : le porteur, le fil (vide), la copie, la saisie. */
function Screen({ requests }: { requests: string[] }) {
  return (
    <PendingTurnProvider requests={requests}>
      <PendingTurn agentName="Intendant" />
      <ThreadComposer conversationId="conv-1" agentName="Intendant" />
    </PendingTurnProvider>
  );
}

async function render(node: React.ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
}

async function rerender(node: React.ReactElement): Promise<void> {
  await act(async () => {
    root.render(node);
  });
}

function textarea(): HTMLTextAreaElement {
  const el = container.querySelector('textarea');
  if (!el) throw new Error('no textarea rendered');
  return el;
}

async function type(text: string): Promise<void> {
  const el = textarea();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function pressEnter(): Promise<void> {
  await act(async () => {
    textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
}

async function send(text: string): Promise<void> {
  await type(text);
  await pressEnter();
}

async function settle(index: number, result: Result): Promise<void> {
  const resolve = resolvers[index];
  if (!resolve) throw new Error(`no send #${index} in flight`);
  await act(async () => {
    resolve(result);
  });
}

function pendingTurn(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-testid="pending-turn"]');
}

/** Les messages en attente, dans l'ordre où le fil les montre. */
function pendingTexts(): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[data-testid="pending-message"]'),
    (el) => el.querySelector('p:last-child')?.textContent ?? '',
  );
}

beforeEach(() => {
  sendChatMessageAction.mockClear();
  refresh.mockClear();
  toastError.mockClear();
  resolvers.length = 0;
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe('PendingTurn — le fil entre l’envoi et la réponse @cap:parler-a-un-agent/ecran', () => {
  it('dès Entrée, le message est dans le fil et l’agent réfléchit — la réponse n’est pas encore là', async () => {
    await render(<Screen requests={feed('Bonjour', 'Où en est la carte ?')} />);
    expect(pendingTurn()).toBeNull();
    await send('Où en est la carte ?');
    // L'action n'a PAS répondu : la promesse est toujours en l'air.
    expect(sendChatMessageAction).toHaveBeenCalledTimes(1);
    const turn = pendingTurn();
    if (!turn) throw new Error('the sent message is not in the feed');
    expect(pendingTexts()).toEqual(['Où en est la carte ?']);
    expect(turn.textContent).toContain('from the dashboard');
    expect(turn.textContent).toContain('Intendant');
    expect(turn.textContent).toContain('thinking');
    // La zone est vidée tout de suite, et reste ouverte : on peut continuer.
    expect(textarea().value).toBe('');
    expect(textarea().disabled).toBe(false);
  });

  it('un second message part sans attendre le premier, et s’ajoute au fil', async () => {
    await render(<Screen requests={feed()} />);
    await send('Première question');
    await send('Et la suite ?');
    expect(sendChatMessageAction).toHaveBeenCalledTimes(2);
    expect(pendingTexts()).toEqual(['Première question', 'Et la suite ?']);
    // L'agent ne réfléchit qu'une fois : il prend les messages dans l'ordre.
    expect(pendingTurn()?.textContent?.match(/thinking/g)).toHaveLength(1);
    expect(textarea().disabled).toBe(false);
  });

  it('quand le serveur a rendu une demande, sa copie s’efface — et seulement la sienne', async () => {
    await render(<Screen requests={feed()} />);
    await send('Première question');
    await send('Et la suite ?');
    await settle(0, { ok: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    // Tant que le fil rendu est le MÊME, les copies restent : effacer avant la
    // relecture ferait clignoter le fil.
    expect(pendingTexts()).toEqual(['Première question', 'Et la suite ?']);
    // Le serveur rend la première demande : sa copie a fait son temps, l'autre attend.
    await rerender(<Screen requests={feed('Première question')} />);
    expect(pendingTexts()).toEqual(['Et la suite ?']);
    await settle(1, { ok: true });
    await rerender(<Screen requests={feed('Première question', 'Et la suite ?')} />);
    expect(pendingTurn()).toBeNull();
  });

  it('deux fois le même texte : les copies s’effacent l’une après l’autre', async () => {
    await render(<Screen requests={feed('ok')} />);
    await send('ok');
    await send('ok');
    expect(pendingTexts()).toEqual(['ok', 'ok']);
    await rerender(<Screen requests={feed('ok', 'ok')} />);
    expect(pendingTexts()).toEqual(['ok']);
    await rerender(<Screen requests={feed('ok', 'ok', 'ok')} />);
    expect(pendingTurn()).toBeNull();
  });

  it('si un envoi échoue, son texte revient dans la zone et sa copie quitte le fil', async () => {
    await render(<Screen requests={feed()} />);
    await send('Un message qui partira');
    await send('Un message qui ne partira pas');
    expect(textarea().value).toBe('');
    await settle(1, { ok: false, message: 'Runner unreachable' });
    expect(toastError.mock.calls).toEqual([['Runner unreachable']]);
    expect(pendingTexts()).toEqual(['Un message qui partira']);
    expect(textarea().value).toBe('Un message qui ne partira pas');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('le texte rendu revient DEVANT ce qu’on a tapé depuis', async () => {
    await render(<Screen requests={feed()} />);
    await send('Perdu');
    await type('Déjà la suite');
    await settle(0, { ok: false, message: 'Runner unreachable' });
    expect(textarea().value).toBe('Perdu\n\nDéjà la suite');
    expect(pendingTurn()).toBeNull();
  });
});
