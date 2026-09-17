// PendingTurn.test.tsx — le fil entre l'envoi et la réponse (Quentin, 18/09).
//
// Ce qui se prouve : dès Entrée, le message envoyé est DANS le fil et l'agent
// « réfléchit » — avant que l'action serveur ait répondu ; la zone est vidée ;
// quand le serveur a rendu le nouveau tour (la signature change), la copie
// s'efface ; si l'envoi échoue, le texte revient dans la zone et rien ne reste
// dans le fil.
//
// Rendu dans jsdom et TAPÉ ; l'action est mockée avec une promesse qu'on
// résout NOUS-MÊMES, pour regarder le fil pendant l'attente (invariant #5 :
// l'état visible, pas un nombre d'appels).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ThreadComposer from '../ThreadComposer.tsx';
import PendingTurn, { PendingTurnProvider, feedSignature } from '../PendingTurn.tsx';

type Result = { ok: true } | { ok: false; message: string };
let resolveSend: (r: Result) => void = () => {};
const sendChatMessageAction = vi.hoisted(() =>
  vi.fn(
    () =>
      new Promise<{ ok: true } | { ok: false; message: string }>((resolve) => {
        resolveSend = resolve;
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

/** L'écran, réduit à ce qui compte : le porteur, le fil (vide), la copie, la saisie. */
function Screen({ signature }: { signature: string }) {
  return (
    <PendingTurnProvider signature={signature}>
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

function pendingTurn(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-testid="pending-turn"]');
}

beforeEach(() => {
  sendChatMessageAction.mockClear();
  refresh.mockClear();
  toastError.mockClear();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe('PendingTurn — le fil entre l’envoi et la réponse @cap:parler-a-un-agent/ecran', () => {
  it('dès Entrée, le message est dans le fil et l’agent réfléchit — la réponse n’est pas encore là', async () => {
    await render(<Screen signature={feedSignature(2, 'answer')} />);
    expect(pendingTurn()).toBeNull();
    await type('Où en est la carte ?');
    await pressEnter();
    // L'action n'a PAS répondu : la promesse est toujours en l'air.
    expect(sendChatMessageAction).toHaveBeenCalledTimes(1);
    const turn = pendingTurn();
    if (!turn) throw new Error('the sent message is not in the feed');
    expect(turn.textContent).toContain('Où en est la carte ?');
    expect(turn.textContent).toContain('from the dashboard');
    expect(turn.textContent).toContain('Intendant');
    expect(turn.textContent).toContain('thinking');
    // La zone est vidée tout de suite, pas au retour.
    expect(textarea().value).toBe('');
  });

  it('quand le serveur a rendu le nouveau tour, la copie s’efface', async () => {
    await render(<Screen signature={feedSignature(2, 'answer')} />);
    await type('Bonjour');
    await pressEnter();
    expect(pendingTurn()).not.toBeNull();
    await act(async () => {
      resolveSend({ ok: true });
    });
    expect(refresh).toHaveBeenCalled();
    // Tant que le fil rendu est le MÊME, la copie reste : effacer avant la
    // relecture ferait clignoter le fil.
    expect(pendingTurn()).not.toBeNull();
    // Le serveur rend deux items de plus : la copie a fait son temps.
    await rerender(<Screen signature={feedSignature(4, 'answer')} />);
    expect(pendingTurn()).toBeNull();
  });

  it('si l’envoi échoue, le texte revient dans la zone et rien ne reste dans le fil', async () => {
    await render(<Screen signature={feedSignature(2, 'answer')} />);
    await type('Un message qui ne partira pas');
    await pressEnter();
    expect(textarea().value).toBe('');
    await act(async () => {
      resolveSend({ ok: false, message: 'Runner unreachable' });
    });
    expect(toastError.mock.calls).toEqual([['Runner unreachable']]);
    expect(pendingTurn()).toBeNull();
    expect(textarea().value).toBe('Un message qui ne partira pas');
    expect(refresh).not.toHaveBeenCalled();
  });
});
