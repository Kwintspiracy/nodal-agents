// SpokenFeed.test.tsx — ce que le FIL dit d'un tour dit (#942).
//
// La demande dite porte « Spoken · 0:03 », lu sur `chat_messages.spoken_ms`
// (rangé par le runner, #941), et la réponse de l'agent porte « Speaking »
// pendant que sa voix joue. Une demande tapée ne porte rien.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import ConversationFeedView from '@/app/(dashboard)/spaces/ConversationFeedView.tsx';
import { buildConversationThread } from '@/lib/conversation-thread.ts';
import { playSpoken, stopSpeaking } from '../voice-playback.ts';

const conversation = {
  id: 'c-1',
  channel: 'dashboard',
  chatId: null,
  title: '',
  agentName: 'Alfred',
  agentSlug: 'alfred',
  agentAvatarUrl: null,
  currentProject: null,
};

function thread() {
  return buildConversationThread({
    conversation,
    messages: [
      {
        id: 'm1',
        role: 'user',
        content: 'What is the capital of Australia?',
        jobId: null,
        createdAt: null,
        spokenMs: 3000,
      },
      { id: 'm2', role: 'assistant', content: 'Canberra.', jobId: null, createdAt: null },
      { id: 'm3', role: 'user', content: 'Thanks', jobId: null, createdAt: null },
      { id: 'm4', role: 'assistant', content: 'You are welcome.', jobId: null, createdAt: null },
    ],
    jobs: [],
  });
}

afterEach(() => {
  stopSpeaking();
  vi.unstubAllGlobals();
});

describe('a spoken turn in the thread (#942) @cap:parler-a-un-agent/ecran', () => {
  it('the request carries the stored spoken duration; a typed one carries none', () => {
    const requests = thread().items.filter((i) => i.kind === 'request');
    expect(requests.map((r) => [r.text, r.spokenMs])).toEqual([
      ['What is the capital of Australia?', 3000],
      ['Thanks', null],
    ]);
  });

  it('a spoken request reads "Spoken · 0:03" under its bubble, a typed one nothing', () => {
    const html = renderToStaticMarkup(<ConversationFeedView feed={thread()} />);
    const spoken = html.match(/data-testid="feed-spoken"[^>]*>(.*?)<\/p>/g) ?? [];
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toContain('Spoken · 0:03');
    // La mention suit la PREMIÈRE demande, pas la seconde.
    expect(html.indexOf('Spoken · 0:03')).toBeGreaterThan(html.indexOf('capital of Australia'));
    expect(html.indexOf('Spoken · 0:03')).toBeLessThan(html.indexOf('Canberra.'));
  });

  it('"Speaking" sits on the reply whose voice is playing, and leaves when it stops', async () => {
    vi.stubGlobal(
      'Audio',
      class {
        addEventListener(): void {}
        play(): Promise<void> {
          return Promise.resolve();
        }
        pause(): void {}
      },
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<ConversationFeedView feed={thread()} />);
    });
    expect(container.textContent).not.toContain('Speaking');

    await act(async () => {
      await playSpoken({ mimeType: 'audio/wav', base64: 'UklGRg==', reply: 'Canberra.' });
    });
    // Sur le tour de « Canberra. », pas sur l'autre réponse.
    const pills = [...container.querySelectorAll('span')].filter(
      (s) => s.textContent === 'Speaking',
    );
    expect(pills).toHaveLength(1);
    const turn = pills[0]?.closest('.pt-6');
    expect(turn?.textContent).toContain('Canberra.');
    expect(turn?.textContent).not.toContain('You are welcome.');

    await act(async () => {
      stopSpeaking();
    });
    expect(container.textContent).not.toContain('Speaking');
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
