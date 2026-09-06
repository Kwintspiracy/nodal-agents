// QuestionCard.test.tsx — la carte de question du fil, et la surface de
// décision de la page Approvals (P10a).
//
// Rendu dans jsdom et CLIQUÉ, pas seulement rendu : ce qui compte n'est pas
// qu'un bouton porte le bon libellé, c'est que le clic passe ce libellé à
// l'action. L'assertion porte donc sur l'ARGUMENT reçu par l'action mockée,
// jamais sur un compte d'appels (invariant #5).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import QuestionCard from '../QuestionCard.tsx';
import ConversationFeedView from '../ConversationFeedView.tsx';
import type { ConversationFeed } from '@/lib/conversation-feed.ts';
import QuestionActions from '../../approvals/QuestionActions.tsx';

const resolveApprovalAction = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true as const,
    data: { jobId: 'j', decision: 'approve', answer: null },
  })),
);
const refresh = vi.hoisted(() => vi.fn());

vi.mock('@/lib/actions.ts', () => ({
  resolveApprovalAction,
  setAgentApprovalRuleAction: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const OPTIONS = ['The repo README', 'A new file in notes'];
const PROMPT = 'Where should I write the summary?';

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

function buttonLabels(): string[] {
  return [...container.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');
}

async function click(label: string): Promise<void> {
  const button = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!button)
    throw new Error(`no button labelled "${label}" — found: ${buttonLabels().join(', ')}`);
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  resolveApprovalAction.mockClear();
  refresh.mockClear();
});

describe('QuestionCard — dans le fil', () => {
  const pending = {
    approvalRequestId: 'apr-1',
    status: 'pending',
    answer: null,
    notes: null,
  };

  it('en attente : un bouton par option', async () => {
    await render(<QuestionCard prompt={PROMPT} options={OPTIONS} question={pending} />);
    expect(container.textContent).toContain(PROMPT);
    expect(buttonLabels()).toEqual(OPTIONS);
  });

  it("le clic passe le LIBELLÉ de l'option à l'action, et rafraîchit le fil", async () => {
    await render(<QuestionCard prompt={PROMPT} options={OPTIONS} question={pending} />);
    await click(OPTIONS[1]!);

    expect(resolveApprovalAction).toHaveBeenCalledWith({
      approvalRequestId: 'apr-1',
      decision: 'approve',
      answer: OPTIONS[1],
    });
    expect(refresh).toHaveBeenCalled();
  });

  it('répondue : plus aucun bouton, et l’option retenue est marquée', async () => {
    await render(
      <QuestionCard
        prompt={PROMPT}
        options={OPTIONS}
        question={{
          approvalRequestId: 'apr-1',
          status: 'approved',
          answer: OPTIONS[1]!,
          notes: null,
        }}
      />,
    );
    expect(buttonLabels()).toEqual([]);
    expect(container.textContent).toContain(`✓ ${OPTIONS[1]}`);
  });

  it('déclinée : dite comme telle, avec la raison', async () => {
    await render(
      <QuestionCard
        prompt={PROMPT}
        options={OPTIONS}
        question={{
          approvalRequestId: 'apr-1',
          status: 'rejected',
          answer: null,
          notes: 'None of these fits',
        }}
      />,
    );
    expect(buttonLabels()).toEqual([]);
    expect(container.textContent).toContain('Declined');
    expect(container.textContent).toContain('None of these fits');
  });

  it("sans ligne chargée : aucun bouton, et l'écran dit où répondre", async () => {
    await render(<QuestionCard prompt={PROMPT} options={OPTIONS} question={null} />);
    expect(buttonLabels()).toEqual([]);
    expect(container.textContent).toContain('Approvals page');
  });
});

describe('QuestionActions — sur la page Approvals', () => {
  it('offre une option par bouton et « Decline », JAMAIS un « toujours »', async () => {
    await render(<QuestionActions approvalId="apr-2" options={OPTIONS} />);
    expect(buttonLabels()).toEqual([...OPTIONS, 'Decline']);
    expect(container.textContent).not.toContain('Always');
    expect(container.textContent).not.toContain('Toujours');
  });

  it("le clic sur une option passe son LIBELLÉ à l'action", async () => {
    await render(<QuestionActions approvalId="apr-2" options={OPTIONS} />);
    await click(OPTIONS[0]!);

    expect(resolveApprovalAction).toHaveBeenCalledWith({
      approvalRequestId: 'apr-2',
      decision: 'approve',
      answer: OPTIONS[0],
    });
  });

  it('« Decline » demande une confirmation avant de refuser, et n’envoie AUCUNE réponse', async () => {
    await render(<QuestionActions approvalId="apr-2" options={OPTIONS} />);

    await click('Decline');
    expect(resolveApprovalAction).not.toHaveBeenCalled();

    await click('Confirm decline');
    expect(resolveApprovalAction).toHaveBeenCalledWith({
      approvalRequestId: 'apr-2',
      decision: 'reject',
    });
  });
});

describe('ConversationFeedView — le dispatch sur la carte `question`', () => {
  it("dessine la carte à boutons depuis l'ENTRÉE relue, sans charge utile ni nom d'outil", async () => {
    // L'appel qui a suspendu le travail n'a PAS de `presented` : rien n'a été
    // exécuté. La question se lit alors sur l'entrée. C'est ce chemin-là qui
    // était mort avant P10a — l'écran retombait sur le brut.
    const feed: ConversationFeed = {
      items: [
        {
          kind: 'turn',
          index: 1,
          turn: 1,
          turnSource: 'audit',
          agent: { name: 'Alfred', slug: 'alfred' },
          model: 'mock',
          blocks: [
            {
              kind: 'card',
              step: {
                kind: 'tool',
                toolName: 'ask_user',
                toolCallId: 'call_ask',
                card: 'question',
                presented: null,
                input: { question: PROMPT, options: OPTIONS },
                outputText: null,
                outcome: 'awaiting_approval',
                durationMs: 4,
                question: {
                  approvalRequestId: 'apr-3',
                  status: 'pending',
                  answer: null,
                  notes: null,
                },
              },
            },
          ],
          usage: null,
        },
      ],
      totals: {
        turns: 1,
        toolCalls: 1,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        cacheCreationTokens: 0,
        costUsd: null,
        llmDurationMs: 0,
        models: [],
      },
    };

    await render(<ConversationFeedView feed={feed} />);
    expect(container.textContent).toContain(PROMPT);
    expect(buttonLabels()).toEqual(OPTIONS);
    // Pas de repli brut : le nom de l'outil n'apparaît pas comme un titre.
    expect(container.textContent).not.toContain('no card recorded');

    await click(OPTIONS[0]!);
    expect(resolveApprovalAction).toHaveBeenCalledWith({
      approvalRequestId: 'apr-3',
      decision: 'approve',
      answer: OPTIONS[0],
    });
  });
});
