// QuestionCard.test.tsx — la carte de question du fil (P10a, #465).
//
// #465 — la question se répond ICI, dans le fil ou sur la page du run, et
// nulle part ailleurs : une ligne par réponse de l'agent, puis la ligne de la
// plateforme, « Something else, I'll explain », qui ouvre un champ dont le
// texte EST la réponse. La page Approvals ne répond plus (QuestionActions a
// disparu) : elle renvoie là où la question vit.
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
/** La ligne de la PLATEFORME (#465), jamais écrite par l'agent. */
const SOMETHING_ELSE = "Something else, I'll explain";
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

/** Écrire dans un champ contrôlé par React : le setter natif, puis l'événement. */
async function type(field: HTMLTextAreaElement, text: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
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

  it('en attente : une ligne par option, puis la ligne de la plateforme, et la carte dit qu’elle attend', async () => {
    await render(<QuestionCard prompt={PROMPT} options={OPTIONS} question={pending} />);
    expect(container.textContent).toContain(PROMPT);
    expect(buttonLabels()).toEqual([...OPTIONS, SOMETHING_ELSE]);
    // Une LIGNE par réponse, pas une rangée de boutons : chacune tient la largeur.
    expect(container.querySelectorAll('[data-testid="question-answer-row"]')).toHaveLength(3);
    // P2bis — forme de la maquette : un cadre encré, une pastille d'attente,
    // et AUCUN bandeau « Question » au-dessus.
    expect(container.textContent).toContain('Waiting');
    expect(container.textContent).not.toContain('Question');
    // P2bis — la question est le seul cadre BLEU du fil : c'est la seule
    // chose qui attend le lecteur, et le design la distingue par sa bordure.
    expect(container.innerHTML).toContain('border-run');
    // Plus de pastille d'état par-dessus : « WAITING » en capitales suffit.
    expect(container.innerHTML).not.toContain('bg-run-bg');
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

  it('« Something else » ouvre un champ EN PLACE, et c’est son texte qui part, dit comme libre', async () => {
    await render(<QuestionCard prompt={PROMPT} options={OPTIONS} question={pending} />);
    expect(container.querySelector('textarea')).toBeNull();

    await click(SOMETHING_ELSE);
    // Cliquer la ligne ne répond RIEN : elle ouvre le champ.
    expect(resolveApprovalAction).not.toHaveBeenCalled();
    const field = container.querySelector('textarea');
    expect(field).not.toBeNull();

    await type(field!, 'Le fichier est dans D:/ventes');
    await click('Send');
    expect(resolveApprovalAction).toHaveBeenCalledWith({
      approvalRequestId: 'apr-1',
      decision: 'approve',
      answer: 'Le fichier est dans D:/ventes',
      free: true,
    });
  });

  it('un champ vide n’envoie rien : le bouton est inerte', async () => {
    await render(<QuestionCard prompt={PROMPT} options={OPTIONS} question={pending} />);
    await click(SOMETHING_ELSE);
    await type(container.querySelector('textarea')!, '   ');
    const send = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Send',
    );
    expect(send?.disabled).toBe(true);
  });

  it('répondue dans ses mots : la carte montre le texte donné', async () => {
    await render(
      <QuestionCard
        prompt={PROMPT}
        options={OPTIONS}
        question={{
          approvalRequestId: 'apr-1',
          status: 'approved',
          answer: 'Le fichier est dans D:/ventes',
          notes: null,
        }}
      />,
    );
    expect(buttonLabels()).toEqual([]);
    expect(container.textContent).toContain('✓ Le fichier est dans D:/ventes');
    expect(container.textContent).toContain('Answered');
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
    // Répondue : elle le DIT, en vert, à la place de « WAITING » (P2bis).
    expect(container.textContent).toContain('Answered');
    expect(container.textContent).not.toContain('Waiting');
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
    // La page Approvals ne répond plus (#465) : la page du run qui a posé la
    // question la porte, toujours.
    expect(container.textContent).not.toContain('Approvals');
    expect(container.textContent).toContain('Open the run that asked it to answer.');
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
          agent: { name: 'Alfred', slug: 'alfred', avatarUrl: null },
          model: 'mock',
          at: null,
          blocks: [
            {
              kind: 'card',
              step: {
                kind: 'tool',
                toolName: 'ask_user',
                toolCallId: 'call_ask',
                jobId: 'job-1',
                lineCounts: {},
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
    expect(buttonLabels()).toEqual([...OPTIONS, SOMETHING_ELSE]);
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
