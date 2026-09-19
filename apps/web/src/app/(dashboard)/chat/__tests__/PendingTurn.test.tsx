// PendingTurn.test.tsx — le fil entre l'envoi et la réponse (Quentin, 18/09).
//
// Ce qui se prouve : dès Entrée, le message envoyé est DANS le fil et l'agent
// « réfléchit » — avant que l'action serveur ait répondu ; la zone est vidée et
// RESTE ouverte : un second message part sans attendre le premier, et s'ajoute
// au fil ; le loader est SOUS le message que le runner traite, et passe sous le
// suivant quand la réponse arrive ; quand le serveur a rendu une demande (son
// texte est dans le fil), sa copie s'efface, et seulement la sienne — deux
// « ok » s'effacent l'un après l'autre ; si un envoi échoue, son texte revient
// dans la zone et sa copie quitte le fil.
//
// Rendu dans jsdom et TAPÉ ; l'action est mockée avec une promesse PAR APPEL
// qu'on résout NOUS-MÊMES, pour regarder le fil pendant l'attente (invariant
// #5 : l'état visible, pas un nombre d'appels).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ThreadComposer from '../ThreadComposer.tsx';
import PendingTurn, { PendingTurnProvider } from '../PendingTurn.tsx';
import { feedAwaitsReply, feedRequests } from '../feed-requests.ts';

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
// Le flux (#152) n'ouvre pas ici. Ce fichier prouve donc, en plus de ce qu'il
// prouvait déjà, que le REPLI sur l'action serveur rend exactement le même
// écran : même copie, même effacement, même retour du texte sur échec.
vi.stubGlobal('fetch', () => Promise.reject(new Error('no stream in this test')));

let container: HTMLDivElement;
let root: Root;

type Item = { kind: 'request' | 'answer'; text: string };
const ask = (text: string): Item => ({ kind: 'request', text });
const say = (text: string): Item => ({ kind: 'answer', text });

/** L'écran, réduit à ce qui compte : le porteur, le fil (tel que le serveur
 *  l'a rendu, réduit à ses demandes et réponses), la copie, la saisie. */
function Screen({ items }: { items: Item[] }) {
  return (
    <PendingTurnProvider requests={feedRequests(items)} awaitingReply={feedAwaitsReply(items)}>
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

/** Ce que le fil montre sous le fil rendu, dans l'ordre : chaque copie par
 *  son texte, et « thinking » là où l'agent réfléchit. */
function shown(): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      '[data-testid="pending-message"], [data-testid="pending-thinking"]',
    ),
    (el) =>
      el.dataset.testid === 'pending-thinking'
        ? 'thinking'
        : (el.querySelector('[data-testid="pending-text"]')?.textContent?.trim() ?? ''),
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
    await render(<Screen items={[ask('Bonjour'), say('Bonjour.')]} />);
    expect(pendingTurn()).toBeNull();
    await send('Où en est la carte ?');
    // L'action n'a PAS répondu : la promesse est toujours en l'air.
    expect(sendChatMessageAction).toHaveBeenCalledTimes(1);
    const turn = pendingTurn();
    if (!turn) throw new Error('the sent message is not in the feed');
    expect(shown()).toEqual(['Où en est la carte ?', 'thinking']);
    expect(turn.textContent).toContain('from the dashboard');
    expect(turn.textContent).toContain('Intendant');
    // La zone est vidée tout de suite, et reste ouverte : on peut continuer.
    expect(textarea().value).toBe('');
    expect(textarea().disabled).toBe(false);
  });

  it('un second message s’ajoute au fil sans attendre, le loader reste sous le premier — et il ne PART qu’une fois le premier répondu', async () => {
    await render(<Screen items={[]} />);
    await send('Première question');
    await send('Et la suite ?');
    expect(shown()).toEqual(['Première question', 'thinking', 'Et la suite ?']);
    expect(textarea().disabled).toBe(false);
    // Le second attend son tour : il ne part que lorsque la réponse au
    // premier est À L'ÉCRAN — pas quand le serveur a répondu (une action
    // lancée avant retiendrait l'affichage de la relecture).
    expect(sendChatMessageAction).toHaveBeenCalledTimes(1);
    await settle(0, { ok: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(sendChatMessageAction).toHaveBeenCalledTimes(1);
    await rerender(<Screen items={[ask('Première question'), say('Réponse 1')]} />);
    expect(sendChatMessageAction).toHaveBeenCalledTimes(2);
    expect(sendChatMessageAction.mock.calls[1]).toEqual([
      { conversationId: 'conv-1', message: 'Et la suite ?' },
    ]);
  });

  it('quand la première réponse est rendue, sa copie s’efface et le loader passe sous le message suivant', async () => {
    await render(<Screen items={[]} />);
    await send('Première question');
    await send('Et la suite ?');
    await settle(0, { ok: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    // Tant que le fil rendu est le MÊME, rien ne bouge : effacer avant la
    // relecture ferait clignoter le fil. Le second n'est pas encore parti.
    expect(shown()).toEqual(['Première question', 'thinking', 'Et la suite ?']);
    expect(sendChatMessageAction).toHaveBeenCalledTimes(1);
    // Le serveur rend le premier tour : sa copie a fait son temps, l'agent
    // réfléchit maintenant sous le second message — qui part à ce moment-là.
    await rerender(<Screen items={[ask('Première question'), say('Réponse 1')]} />);
    expect(shown()).toEqual(['Et la suite ?', 'thinking']);
    expect(sendChatMessageAction).toHaveBeenCalledTimes(2);
    await settle(1, { ok: true });
    await rerender(
      <Screen
        items={[ask('Première question'), say('Réponse 1'), ask('Et la suite ?'), say('Réponse 2')]}
      />,
    );
    expect(pendingTurn()).toBeNull();
  });

  it('quand le runner a déjà écrit le message suivant sans y répondre, le loader est sous LUI, avant les copies', async () => {
    await render(<Screen items={[]} />);
    await send('Première question');
    await send('Et la suite ?');
    await send('Une troisième');
    await settle(0, { ok: true });
    // Le fil relu porte la première réponse ET la deuxième demande, que le
    // runner a écrite en ouvrant son tour : c'est sous elle qu'il réfléchit.
    await rerender(
      <Screen items={[ask('Première question'), say('Réponse 1'), ask('Et la suite ?')]} />,
    );
    expect(shown()).toEqual(['thinking', 'Une troisième']);
  });

  it('un fil qui se termine sur une demande sans réponse ne fait pas réfléchir l’agent pour de faux', async () => {
    await render(<Screen items={[ask('Une question d’hier restée sans réponse')]} />);
    expect(pendingTurn()).toBeNull();
  });

  it('deux fois le même texte : les copies s’effacent l’une après l’autre', async () => {
    await render(<Screen items={[ask('ok'), say('Bien.')]} />);
    await send('ok');
    await send('ok');
    expect(shown()).toEqual(['ok', 'thinking', 'ok']);
    await settle(0, { ok: true });
    await rerender(<Screen items={[ask('ok'), say('Bien.'), ask('ok'), say('Bien.')]} />);
    expect(shown()).toEqual(['ok', 'thinking']);
    await settle(1, { ok: true });
    await rerender(
      <Screen
        items={[ask('ok'), say('Bien.'), ask('ok'), say('Bien.'), ask('ok'), say('Bien.')]}
      />,
    );
    expect(pendingTurn()).toBeNull();
  });

  it('si un envoi échoue, son texte revient dans la zone et sa copie quitte le fil', async () => {
    await render(<Screen items={[]} />);
    await send('Un message qui partira');
    await send('Un message qui ne partira pas');
    expect(textarea().value).toBe('');
    await settle(0, { ok: true });
    await rerender(<Screen items={[ask('Un message qui partira'), say('Bien reçu.')]} />);
    expect(shown()).toEqual(['Un message qui ne partira pas', 'thinking']);
    await settle(1, { ok: false, message: 'Runner unreachable' });
    expect(toastError.mock.calls).toEqual([['Runner unreachable']]);
    expect(pendingTurn()).toBeNull();
    expect(textarea().value).toBe('Un message qui ne partira pas');
    // Une seule relecture : celle du message qui est parti.
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('un envoi qui échoue ne bloque pas celui qui attend derrière lui', async () => {
    await render(<Screen items={[]} />);
    await send('Celui qui échoue');
    await send('Celui qui suit');
    await settle(0, { ok: false, message: 'Runner unreachable' });
    expect(shown()).toEqual(['Celui qui suit', 'thinking']);
    expect(sendChatMessageAction).toHaveBeenCalledTimes(2);
    expect(textarea().value).toBe('Celui qui échoue');
  });

  it('le texte rendu revient DEVANT ce qu’on a tapé depuis', async () => {
    await render(<Screen items={[]} />);
    await send('Perdu');
    await type('Déjà la suite');
    await settle(0, { ok: false, message: 'Runner unreachable' });
    expect(textarea().value).toBe('Perdu\n\nDéjà la suite');
    expect(pendingTurn()).toBeNull();
  });
});
