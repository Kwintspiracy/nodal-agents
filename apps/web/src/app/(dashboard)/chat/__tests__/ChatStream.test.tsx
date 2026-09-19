// ChatStream.test.tsx — la réponse qui s'écrit sous les yeux (#152).
//
// Ce qui se prouve, à l'écran et sur le texte affiché (invariant #5) :
//   1. dès le premier fragment, le fil montre la réponse EN TRAIN de s'écrire,
//      à la place des trois points, et elle s'allonge fragment après fragment ;
//   2. le tour fini, la copie cède la place au fil relu par le serveur ;
//   3. un flux qui échoue n'a JAMAIS le droit de laisser sa phrase à moitié
//      écrite à l'écran comme si c'était la réponse : elle disparaît, l'échec
//      se dit, et le texte envoyé revient dans la zone (invariant #4).
//
// Le flux est un vrai flux : un `ReadableStream` qu'on alimente nous-mêmes,
// événement par événement, pour regarder l'écran entre deux fragments.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ThreadComposer from '../ThreadComposer.tsx';
import PendingTurn, { PendingTurnProvider } from '../PendingTurn.tsx';
import { feedAwaitsReply, feedRequests } from '../feed-requests.ts';

const sendChatMessageAction = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/actions.ts', () => ({
  sendChatMessageAction,
  setAgentModelAndEffortAction: vi.fn(),
  listKeyModelsAction: vi.fn(async () => ({ ok: true, data: [] })),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: toastError } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

/** Un flux SSE qu'on alimente à la main, comme le ferait la route web. */
function openStream(): {
  response: Response;
  send: (event: string, data: unknown) => void;
  close: () => void;
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const encoder = new TextEncoder();
  return {
    response: new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }),
    send: (event, data) => {
      controller?.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    },
    close: () => controller?.close(),
  };
}

let container: HTMLDivElement;
let root: Root;

type Item = { kind: 'request' | 'answer'; text: string };
const ask = (text: string): Item => ({ kind: 'request', text });
const say = (text: string): Item => ({ kind: 'answer', text });

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
  // Le setter natif : React écoute la valeur de l'élément, pas l'affectation.
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

/** Laisse le lecteur du flux avancer, puis React rendre. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Ce que l'agent dit à l'écran en ce moment — vide s'il n'a encore rien dit. */
function replyOnScreen(): string {
  // Le Markdown rend un paragraphe : l'espace de fin d'un fragment n'y survit
  // pas, et c'est bien ainsi — on lit ce qui est AFFICHE.
  return (container.querySelector('[data-testid="pending-reply"]')?.textContent ?? '').trim();
}

function thinkingDots(): boolean {
  const el = container.querySelector('[data-testid="pending-thinking"]');
  return el !== null && el.textContent?.includes('thinking') === true;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sendChatMessageAction.mockReset();
  refresh.mockReset();
  toastError.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('la réponse du chat en flux @cap:parler-a-un-agent/ecran', () => {
  it('montre la réponse mot à mot, puis laisse le fil relu prendre le relais', async () => {
    const stream = openStream();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(stream.response)),
    );

    await render(<Screen items={[]} />);
    await type('dis-moi tout');
    await pressEnter();

    // Rien n'est encore arrivé : l'agent réfléchit, il ne dit rien.
    expect(container.querySelector('[data-testid="pending-message"]')?.textContent).toContain(
      'dis-moi tout',
    );
    expect(thinkingDots()).toBe(true);
    expect(replyOnScreen()).toBe('');

    stream.send('delta', { text: 'Voici ' });
    await settle();
    expect(replyOnScreen()).toBe('Voici');
    // Le texte a remplacé les trois points : on ne montre pas les deux.
    expect(thinkingDots()).toBe(false);

    stream.send('delta', { text: 'la ' });
    await settle();
    expect(replyOnScreen()).toBe('Voici la');

    stream.send('delta', { text: 'réponse.' });
    await settle();
    expect(replyOnScreen()).toBe('Voici la réponse.');

    stream.send('done', { reply: 'Voici la réponse.', spawnedJobId: null });
    stream.close();
    await settle();
    // La copie tient jusqu'à ce que le fil porte le tour — c'est le fil qui
    // fait foi, et il vient d'être redemandé.
    expect(refresh).toHaveBeenCalled();
    expect(replyOnScreen()).toBe('Voici la réponse.');

    // Le serveur rend le tour : la copie s'efface d'elle-même.
    await rerender(<Screen items={[ask('dis-moi tout'), say('Voici la réponse.')]} />);
    expect(container.querySelector('[data-testid="pending-turn"]')).toBeNull();
    // Et la zone est restée vide : le message est parti pour de bon.
    expect(textarea().value).toBe('');
  });

  it('un flux en erreur ne laisse aucun texte à moitié écrit passer pour la réponse', async () => {
    const stream = openStream();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(stream.response)),
    );

    await render(<Screen items={[]} />);
    await type('et là ?');
    await pressEnter();

    stream.send('delta', { text: 'Je commence à répond' });
    await settle();
    expect(replyOnScreen()).toBe('Je commence à répond');

    stream.send('error', { error: 'llm_error' });
    stream.close();
    await settle();

    // Le morceau de phrase a disparu, l'échec est dit, et le texte envoyé est
    // revenu dans la zone — le même bloc d'échec que n'importe quel envoi raté.
    expect(container.querySelector('[data-testid="pending-reply"]')).toBeNull();
    expect(container.querySelector('[data-testid="pending-turn"]')).toBeNull();
    expect(toastError).toHaveBeenCalledWith('The agent did not reply');
    expect(textarea().value).toBe('et là ?');
  });

  it('sans flux, l’envoi repasse par le chemin d’avant et la réponse arrive d’un bloc', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('stream refused'))),
    );
    sendChatMessageAction.mockResolvedValue({ ok: true, data: { reply: 'Réponse entière.' } });

    await render(<Screen items={[]} />);
    await type('et sans flux ?');
    await pressEnter();
    await settle();

    // Le repli est EXPLICITE : c'est l'action serveur qui a joué le tour, le
    // fil est redemandé, et rien de partiel n'a été inventé entre-temps.
    expect(sendChatMessageAction).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      message: 'et sans flux ?',
    });
    expect(refresh).toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();

    await rerender(<Screen items={[ask('et sans flux ?'), say('Réponse entière.')]} />);
    expect(container.querySelector('[data-testid="pending-turn"]')).toBeNull();
  });
});
