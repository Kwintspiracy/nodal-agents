// NewConversationComposer.test.tsx — LE GESTE de #248 : c'est le premier
// message qui fait naître la conversation, jamais l'ouverture de l'écran.
//
// Rendu dans jsdom et TAPÉ, pas seulement rendu. Les assertions portent sur les
// ARGUMENTS reçus — quelle conversation, quel texte, quelle adresse — et jamais
// sur un nombre d'appels seul (invariant #5).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import NewConversationComposer from '../NewConversationComposer.tsx';

const createConversationAction = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true as const, data: { id: 'conv-née' } })),
);
const createProjectConversationAction = vi.hoisted(() =>
  vi.fn(async (_projectId: string) => ({ ok: true as const, data: { id: 'conv-projet' } })),
);
const sendChatMessage = vi.hoisted(() =>
  vi.fn(
    async (_opts: { conversationId: string; message: string; onText: (t: string) => void }) => ({
      ok: true as const,
      reply: 'ok',
      streamed: false,
    }),
  ),
);
const replace = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock('@/lib/actions.ts', () => ({ createConversationAction }));
vi.mock('@/lib/project-actions.ts', () => ({ createProjectConversationAction }));
vi.mock('../chat-stream.ts', () => ({ sendChatMessage }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: toastError } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace, refresh }) }));

let container: HTMLDivElement;
let root: Root;

async function render(node: React.ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
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

async function press(key: string): Promise<void> {
  await act(async () => {
    textarea().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
  // La file d'envoi est une chaîne de promesses : on la laisse se dérouler.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  createConversationAction.mockClear();
  createProjectConversationAction.mockClear();
  sendChatMessage.mockClear();
  replace.mockClear();
  refresh.mockClear();
  toastError.mockClear();
  container?.remove();
});

describe('NewConversationComposer @cap:parler-a-un-agent/ecran', () => {
  it('OUVRIR l’écran n’écrit rien : aucune conversation n’est créée au rendu', async () => {
    await render(<NewConversationComposer agentName="Alfred" />);
    expect(createConversationAction.mock.calls).toEqual([]);
    expect(createProjectConversationAction.mock.calls).toEqual([]);
    expect(sendChatMessage.mock.calls).toEqual([]);
    // L'écran est bien là, il attend juste qu'on parle.
    expect(textarea().placeholder).toBe('What are we doing today?');
  });

  it('le premier envoi crée la conversation ET y envoie le message, dans ce geste-là', async () => {
    await render(<NewConversationComposer agentName="Alfred" />);
    await type('Range le dossier');
    await press('Enter');

    expect(createConversationAction.mock.calls.length).toBe(1);
    // Le message part vers la conversation QUI VIENT DE NAÎTRE, avec le texte
    // tel quel — c'est l'argument qui le dit, pas un compteur.
    const [envoi] = sendChatMessage.mock.calls;
    expect(envoi?.[0]?.conversationId).toBe('conv-née');
    expect(envoi?.[0]?.message).toBe('Range le dossier');
  });

  it('puis l’écran DEVIENT ce fil : /chat/<id>, en remplacement', async () => {
    await render(<NewConversationComposer agentName="Alfred" />);
    await type('Bonjour');
    await press('Enter');
    expect(replace.mock.calls).toEqual([['/chat/conv-née']]);
    // Pas de relecture de l'écran vide : on n'y est plus.
    expect(refresh.mock.calls).toEqual([]);
  });

  it('deux envois d’affilée n’ouvrent qu’UNE conversation', async () => {
    await render(<NewConversationComposer agentName="Alfred" />);
    await type('Premier');
    await press('Enter');
    await type('Second');
    await press('Enter');
    expect(createConversationAction.mock.calls.length).toBe(1);
    expect(sendChatMessage.mock.calls.map((c) => c[0]?.conversationId)).toEqual([
      'conv-née',
      'conv-née',
    ]);
  });

  it('avec un projet, la conversation naît ANCRÉE à lui', async () => {
    await render(<NewConversationComposer projectId="p-1" agentName="Alfred" />);
    await type('On reprend le dossier');
    await press('Enter');
    expect(createProjectConversationAction.mock.calls).toEqual([['p-1']]);
    expect(createConversationAction.mock.calls).toEqual([]);
    expect(sendChatMessage.mock.calls[0]?.[0]?.conversationId).toBe('conv-projet');
    expect(replace.mock.calls).toEqual([['/chat/conv-projet']]);
  });

  it('création refusée : RIEN n’est envoyé, on le dit, et le texte revient', async () => {
    createConversationAction.mockResolvedValueOnce({
      ok: false,
      code: 'no_root_agent',
      message: 'No ROOT agent yet.',
    } as never);
    await render(<NewConversationComposer agentName="Alfred" />);
    await type('Un message perdu ?');
    await press('Enter');

    expect(sendChatMessage.mock.calls).toEqual([]);
    expect(replace.mock.calls).toEqual([]);
    expect(toastError.mock.calls).toEqual([['No ROOT agent yet.']]);
    // Le texte n'est pas perdu : il est retombé dans la zone.
    expect(textarea().value).toBe('Un message perdu ?');
  });
});
