// LiveTurn.test.tsx — une page rouverte PENDANT la réponse s'y rebranche (#457).
//
// Le 23/09 : la personne quitte la page pendant qu'Alfred écrit, revient, et ne
// voit que sa question — rien ne dit que la réponse s'écrit, puis elle tombe
// d'un coup. Ce qui se prouve ici, dans jsdom, sur le VRAI porteur, la VRAIE
// copie et la VRAIE saisie : le fil rendu se termine sur une demande sans
// réponse, la page lit `/api/chat/live` (simulé : un flux qu'on écrit
// nous-mêmes), montre ce qui était déjà écrit, puis la suite ; à la fin elle
// relit le fil ; et Stop, dans la saisie, arrête ce tour-là.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ThreadComposer from '../ThreadComposer.tsx';
import PendingTurn, { PendingTurnProvider, elapsedLabel } from '../PendingTurn.tsx';
import { feedAwaitsReply, feedRequests } from '../feed-requests.ts';

const refresh = vi.hoisted(() => vi.fn());
// Stable, comme le routeur de Next : un objet neuf à chaque rendu relancerait
// la lecture à chaque fragment.
const router = vi.hoisted(() => ({ refresh }));
vi.mock('@/lib/actions.ts', () => ({
  sendChatMessageAction: vi.fn(),
  setAgentModelAndEffortAction: vi.fn(),
  listKeyModelsAction: vi.fn(async () => ({ ok: true, data: [] })),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

/** Le flux de `/api/chat/live`, écrit à la main par le test. */
let live: ReadableStreamDefaultController<Uint8Array> | null = null;
let liveStatus = 200;
const calls: Array<{ url: string; body: unknown }> = [];
const encoder = new TextEncoder();
const emit = (event: string, data: unknown): void => {
  live?.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
};

vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
  calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
  if (url === '/api/chat/stop') {
    return new Response(JSON.stringify({ stopped: true }), { status: 200 });
  }
  if (url !== '/api/chat/live') throw new Error(`unexpected fetch ${url}`);
  if (liveStatus === 204) return new Response(null, { status: 204 });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      live = controller;
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
});

type Item = { kind: 'request' | 'answer'; text: string };

function Screen({ items }: { items: Item[] }) {
  return (
    <PendingTurnProvider
      requests={feedRequests(items)}
      awaitingReply={feedAwaitsReply(items)}
      conversationId="conv-1"
    >
      <PendingTurn agentName="Alfred" />
      <ThreadComposer conversationId="conv-1" agentName="Alfred" />
    </PendingTurnProvider>
  );
}

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

/** Laisse passer les microtâches du flux jusqu'à l'écran. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

const replyShown = (): string =>
  container.querySelector('[data-testid="pending-reply"]')?.textContent ?? '';

beforeEach(() => {
  refresh.mockReset();
  calls.length = 0;
  live = null;
  liveStatus = 200;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('se rebrancher sur la réponse qui s’écrit @cap:parler-a-un-agent/ecran', () => {
  it('montre ce qui était écrit, puis la suite, et relit le fil à la fin', async () => {
    await render(<Screen items={[{ kind: 'request', text: 'la machine à vapeur' }]} />);
    await flush();
    expect(calls.map((c) => c.url)).toEqual(['/api/chat/live']);
    expect(calls[0]?.body).toEqual({ conversationId: 'conv-1' });

    emit('start', { startedAt: Date.now() - 65_000 });
    emit('delta', { text: 'La vapeur ' });
    await flush();
    expect(replyShown()).toContain('La vapeur');

    emit('delta', { text: 'pousse le piston.' });
    await flush();
    // Le texte GRANDIT : c'est la réponse en train d'arriver, pas une photo.
    expect(replyShown()).toContain('La vapeur pousse le piston.');
    expect(refresh).not.toHaveBeenCalled();

    emit('end', {});
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  // Revue de la PR #502 : un tour suivi qui finit en ERREUR n'écrit aucune
  // réponse en base. Le fil relu attend toujours, et la demi-réponse suivie
  // restait à l'écran, figée, comme si c'était la réponse.
  it('un tour fini SANS réponse en base ne laisse pas sa demi-réponse figée', async () => {
    await render(<Screen items={[{ kind: 'request', text: 'la machine à vapeur' }]} />);
    await flush();
    emit('start', { startedAt: Date.now() - 5_000 });
    emit('delta', { text: 'La vapeur pou' });
    await flush();
    expect(replyShown()).toContain('La vapeur pou');

    // Le tour s'arrête ; la relecture (ici, le faux routeur) rend le MÊME fil,
    // toujours sans réponse.
    emit('end', {});
    await flush();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(replyShown()).not.toContain('La vapeur pou');
  });

  it('avant le premier mot, dit que l’agent réfléchit et depuis combien de temps', async () => {
    await render(<Screen items={[{ kind: 'request', text: 'une longue note' }]} />);
    await flush();
    emit('start', { startedAt: Date.now() - 65_000 });
    await flush();

    expect(container.querySelector('[data-testid="pending-thinking"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="pending-elapsed"]')?.textContent).toMatch(
      /^1m 0[5-9]s$/,
    );
  });

  it('aucun tour ne tourne : rien n’est montré, et le fil est relu une fois', async () => {
    liveStatus = 204;
    await render(<Screen items={[{ kind: 'request', text: 'une question d’hier' }]} />);
    await flush();

    expect(container.querySelector('[data-testid="pending-thinking"]')).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('un fil qui n’attend aucune réponse ne lit rien', async () => {
    await render(
      <Screen
        items={[
          { kind: 'request', text: 'bonjour' },
          { kind: 'answer', text: 'bonjour !' },
        ]}
      />,
    );
    await flush();

    expect(calls).toEqual([]);
  });

  it('Stop, dans la saisie, arrête le tour suivi', async () => {
    await render(<Screen items={[{ kind: 'request', text: 'une longue note' }]} />);
    await flush();
    emit('start', { startedAt: Date.now() });
    emit('delta', { text: 'Premier mot' });
    await flush();

    const stop = container.querySelector<HTMLButtonElement>('[data-testid="composer-stop"]');
    expect(stop).not.toBeNull();
    await act(async () => {
      stop!.click();
    });
    await flush();

    expect(calls.filter((c) => c.url === '/api/chat/stop')).toEqual([
      { url: '/api/chat/stop', body: { conversationId: 'conv-1' } },
    ]);
  });
});

describe('elapsedLabel', () => {
  it('dit les secondes, puis les minutes', () => {
    expect(elapsedLabel(42_000)).toBe('42s');
    expect(elapsedLabel(185_000)).toBe('3m 05s');
  });
});
